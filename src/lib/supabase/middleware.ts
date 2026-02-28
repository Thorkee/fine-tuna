import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { sanitizeNextRedirect } from '@/lib/redirects'

function stripAuthParamsFromSearchParams(params: URLSearchParams): URLSearchParams {
    const next = new URLSearchParams(params)
    // Supabase OAuth / auth redirects commonly include these.
    next.delete('code')
    next.delete('next')
    next.delete('error')
    next.delete('error_description')
    next.delete('error_code')
    return next
}

function buildNextParam(request: NextRequest): string {
    const pathname = request.nextUrl.pathname
    const stripped = stripAuthParamsFromSearchParams(new URLSearchParams(request.nextUrl.searchParams))
    const search = stripped.toString()
    const hash = request.nextUrl.hash || ''
    return `${pathname}${search ? `?${search}` : ''}${hash}`
}

export async function updateSession(request: NextRequest) {
    let response = NextResponse.next({
        request: {
            headers: request.headers,
        },
    })

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
    const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    if (!supabaseUrl || !supabaseAnonKey) {
        console.error('Supabase env missing in middleware; skipping session refresh.')
        return response
    }

    const withSupabaseCookies = (res: NextResponse) => {
        // If Supabase refreshed the session cookie in `setAll`, ensure redirects carry it too.
        response.cookies.getAll().forEach(({ name, value, ...options }) => {
            res.cookies.set({ name, value, ...options })
        })
        return res
    }

    let supabase: ReturnType<typeof createServerClient>
    try {
        supabase = createServerClient(
            supabaseUrl,
            supabaseAnonKey,
            {
                cookies: {
                    getAll() {
                        return request.cookies.getAll()
                    },
                    setAll(cookiesToSet) {
                        cookiesToSet.forEach(({ name, value, options }) =>
                            request.cookies.set({ name, value, ...(options ?? {}) })
                        )
                        response = NextResponse.next({
                            request: {
                                headers: request.headers,
                            },
                        })
                        cookiesToSet.forEach(({ name, value, options }) =>
                            response.cookies.set({ name, value, ...(options ?? {}) })
                        )
                    },
                },
            }
        )
    } catch (error) {
        console.error('Failed to create Supabase client in middleware:', error)
        return response
    }

    const {
        data: { user },
    } = await supabase.auth.getUser()

    const pathname = request.nextUrl.pathname
    const isLoginRoute = pathname.startsWith('/login')
    const isAuthRoute = pathname.startsWith('/auth')
    const isOnboardingRoute = pathname.startsWith('/onboarding')
    const isApiRoute = pathname.startsWith('/api')
    const isShareRoute = pathname.startsWith('/share')
    const editParam = request.nextUrl.searchParams.get('edit')
    const isOnboardingEdit = editParam === '1' || editParam === 'true'

    if (
        !user &&
        !isLoginRoute &&
        !isAuthRoute &&
        !isApiRoute &&
        !isShareRoute
    ) {
        // no user, potentially respond by redirecting the user to the login page
        const url = request.nextUrl.clone()
        url.pathname = '/login'
        // Important: do NOT preserve existing query params like `code` when redirecting.
        url.search = ''
        url.searchParams.set('next', buildNextParam(request))
        return withSupabaseCookies(NextResponse.redirect(url))
    }

    // Mandatory onboarding gate for authenticated users
    if (user) {
        let onboardingCompleted: boolean | null = null

        const { data: profile, error: profileError } = await supabase
            .from('profiles')
            .select('onboarding_completed')
            .eq('id', user.id)
            .maybeSingle()

        if (profileError) {
            // If migrations haven't been applied yet, fail open (do not block the app).
            // Once `profiles.onboarding_completed` exists, this becomes fully enforced.
            onboardingCompleted = true
        } else {
            onboardingCompleted = profile?.onboarding_completed === true
        }

        if (!onboardingCompleted && !isOnboardingRoute && !isAuthRoute && !isLoginRoute && !isApiRoute && !isShareRoute) {
            const url = request.nextUrl.clone()
            url.pathname = '/onboarding'
            // Important: do NOT preserve existing query params like `code` when redirecting.
            url.search = ''
            url.searchParams.set('next', buildNextParam(request))
            return withSupabaseCookies(NextResponse.redirect(url))
        }

        if (onboardingCompleted && isOnboardingRoute && !isOnboardingEdit) {
            const safeNext = sanitizeNextRedirect(request.nextUrl.searchParams.get('next'))
            return withSupabaseCookies(NextResponse.redirect(new URL(safeNext, request.url)))
        }

        if (!onboardingCompleted && isLoginRoute) {
            const url = request.nextUrl.clone()
            url.pathname = '/onboarding'
            url.searchParams.set('next', '/')
            return withSupabaseCookies(NextResponse.redirect(url))
        }

        if (onboardingCompleted && isLoginRoute) {
            return withSupabaseCookies(NextResponse.redirect(new URL('/', request.url)))
        }
    }

    return response
}
