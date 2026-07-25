import { Button, Card, Input, Label, PasswordInput } from '@/components/ui/primitives'
import { useAuth } from '@/context/AuthContext'
import { supabaseConfigured } from '@/lib/supabase'
import { useState, type FormEvent } from 'react'

type Mode = 'signin' | 'signup' | 'reset'

export default function LoginPage() {
  const { signIn, signUp, resetPassword } = useAuth()
  const [mode, setMode] = useState<Mode>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    setInfo(null)
    try {
      if (mode === 'signin') {
        const err = await signIn(email, password)
        if (err) setError(err)
      } else if (mode === 'signup') {
        const err = await signUp(email, password)
        if (err) setError(err)
        else setInfo('Account created. If email confirmation is enabled, check your inbox.')
      } else {
        const err = await resetPassword(email)
        if (err) setError(err)
        else setInfo('Password reset email sent — check your inbox.')
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center p-4">
      <Card className="w-full max-w-sm p-6">
        <div className="mb-5 flex items-center gap-3">
          <img src="/logo.svg" alt="My Money" className="h-11 w-11 rounded-2xl shadow-md" />
          <div>
            <h1 className="text-xl font-extrabold tracking-tight">My Money</h1>
            <p className="text-[11px] text-ink-faint">Your private financial command centre</p>
          </div>
        </div>
        {!supabaseConfigured && (
          <p className="mb-4 rounded-lg bg-warn/10 p-3 text-xs text-warn">
            Supabase is not configured. Copy <code>.env.example</code> to <code>.env</code> and
            set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY, then restart the dev server.
          </p>
        )}
        <form onSubmit={onSubmit} className="space-y-3">
          <div>
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          {mode !== 'reset' && (
            <div>
              <Label htmlFor="password">Password</Label>
              <PasswordInput
                id="password"
                autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
          )}
          {error && <p className="text-xs text-bad">{error}</p>}
          {info && <p className="text-xs text-good">{info}</p>}
          <Button type="submit" className="w-full" disabled={busy || !supabaseConfigured}>
            {mode === 'signin' ? 'Sign in' : mode === 'signup' ? 'Create account' : 'Send reset email'}
          </Button>
        </form>
        <div className="mt-4 flex justify-between text-xs text-ink-muted">
          {mode !== 'signin' ? (
            <button className="hover:text-ink cursor-pointer" onClick={() => setMode('signin')}>
              Back to sign in
            </button>
          ) : (
            <>
              <button className="hover:text-ink cursor-pointer" onClick={() => setMode('signup')}>
                Create account
              </button>
              <button className="hover:text-ink cursor-pointer" onClick={() => setMode('reset')}>
                Forgot password?
              </button>
            </>
          )}
        </div>
      </Card>
    </div>
  )
}
