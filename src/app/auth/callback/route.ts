import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { sanitizeNextRedirect } from '@/lib/redirects'
import { sendWelcomeEmail } from '@/lib/notifications/email'

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null
}

export async function GET(request: Request) {
    const { searchParams, origin } = new URL(request.url)
    const code = searchParams.get('code')
    // if "next" is in param, use it as the redirect URL
    const next = sanitizeNextRedirect(searchParams.get('next'))

    if (code) {
        const supabase = await createClient()
        const { error } = await supabase.auth.exchangeCodeForSession(code)
        if (!error) {
            const {
                data: { user }
            } = await supabase.auth.getUser()
            if (user?.email) {
                const { data: profile } = await supabase
                    .from('profiles')
                    .select('full_name, preferences')
                    .eq('id', user.id)
                    .maybeSingle()

                const prefs = (profile?.preferences ?? {}) as Record<string, unknown>
                const commPrefs = isRecord(prefs.comm) ? prefs.comm : {}
                const sentAt =
                    typeof commPrefs.welcome_sent_at === 'string' ? commPrefs.welcome_sent_at.trim() : ''

                if (!sentAt) {
                    try {
                        await sendWelcomeEmail({
                            email: user.email,
                            name: profile?.full_name ?? (user.user_metadata?.full_name as string | undefined)
                        })
                        await supabase.from('profiles').upsert(
                            {
                                id: user.id,
                                preferences: {
                                    ...prefs,
                                    comm: {
                                        ...commPrefs,
                                        welcome_sent_at: new Date().toISOString()
                                    }
                                }
                            },
                            { onConflict: 'id' }
                        )
                    } catch (err) {
                        console.error('Failed to send welcome email:', err)
                    }
                }
            }
            const forwardedHost = request.headers.get('x-forwarded-host') // original origin before load balancer
            const isLocalEnv = process.env.NODE_ENV === 'development'
            if (isLocalEnv) {
                // we can be sure that there is no load balancer in between, so no need to watch for X-Forwarded-Host
                return NextResponse.redirect(`${origin}${next}`)
            } else if (forwardedHost) {
                return NextResponse.redirect(`https://${forwardedHost}${next}`)
            } else {
                return NextResponse.redirect(`${origin}${next}`)
            }
        }
    }

    // return the user to an error page with instructions
    return NextResponse.redirect(`${origin}/auth/auth-code-error`)
}
