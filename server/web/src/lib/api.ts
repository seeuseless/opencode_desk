export const TOKEN_KEY = 'template_token'

export function getToken(): string | null {
    return localStorage.getItem(TOKEN_KEY)
}

export async function api<T = unknown>(path: string, options: RequestInit = {}): Promise<T> {
    const token = getToken()
    const isForm = options.body instanceof FormData
    const res = await fetch(`/api${path}`, {
        ...options,
        headers: {
            ...(isForm ? {} : { 'Content-Type': 'application/json' }),
            Accept: 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...(options.headers || {}),
        },
    })

    if (res.status === 401 && token) {
        localStorage.removeItem(TOKEN_KEY)
        window.location.href = '/login'
        throw new Error('Unauthorized')
    }

    const data = await res.json().catch(() => null)

    if (!res.ok) {
        const errors = data?.errors as Record<string, string[]> | undefined
        const msg =
            data?.message ||
            (errors ? Object.values(errors)[0]?.[0] : null) ||
            `HTTP ${res.status}`
        throw new Error(Array.isArray(msg) ? msg[0] : msg)
    }

    return data as T
}
