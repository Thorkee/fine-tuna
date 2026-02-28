import { type EmailOtpType } from '@supabase/supabase-js'
import { type NextRequest, NextResponse } from 'next/server'

import { createClient } from '@/lib/supabase/server'
import { sanitizeNextRedirect } from '@/lib/redirects'
import { sendWelcomeEmail } from '@/lib/notifications/email'

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null
}

export async function GET(request: NextRequest) {
    const { searchParams, origin } = new URL(request.url)
    const token_hash = searchParams.get('token_hash')
    const type = searchParams.get('type') as EmailOtpType | null
    const next = sanitizeNextRedirect(searchParams.get('next'))

    if (token_hash && type) {
        const supabase = await createClient()

        const { error } = await supabase.auth.verifyOtp({
            type,
            token_hash,
        })
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

            const forwardedHost = request.headers.get('x-forwarded-host')
            const isLocalEnv = process.env.NODE_ENV === 'development'
            if (isLocalEnv) return NextResponse.redirect(`${origin}${next}`)
            if (forwardedHost) return NextResponse.redirect(`https://${forwardedHost}${next}`)
            return NextResponse.redirect(`${origin}${next}`)
        }
    }

    // redirect the user to an error page with some instructions
    return NextResponse.redirect('/auth/auth-code-error')
}
