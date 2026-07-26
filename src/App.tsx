import { Spinner } from '@/components/ui/primitives'
import { useAuth } from '@/context/AuthContext'
import { logAppError } from '@/lib/api'
import { lazy, Suspense, useEffect } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import AppLayout from './components/layout/AppLayout'
import LoginPage from './pages/auth/LoginPage'

/**
 * Pages are code-split, so a tab left open across a deploy still points at the
 * previous build's chunk filenames — those 404 and the page never renders.
 * Reload once to pick up the new index, guarded so a genuinely broken chunk
 * can't put the app in a reload loop.
 */
function lazyPage<T extends { default: React.ComponentType<unknown> }>(load: () => Promise<T>) {
  return lazy(() =>
    load().catch((err: unknown) => {
      const stale = sessionStorage.getItem('chunk-reload')
      if (!stale) {
        sessionStorage.setItem('chunk-reload', String(Date.now()))
        window.location.reload()
        return new Promise<T>(() => {}) // never resolves; the reload takes over
      }
      throw err
    }),
  )
}

const HomePage = lazyPage(() => import('./pages/home/HomePage'))
const TransactionsPage = lazyPage(() => import('./pages/transactions/TransactionsPage'))
const BudgetPage = lazyPage(() => import('./pages/budget/BudgetPage'))
const CashflowPage = lazyPage(() => import('./pages/cashflow/CashflowPage'))
const DebtsPage = lazyPage(() => import('./pages/debts/DebtsPage'))
const DebtDetailPage = lazyPage(() => import('./pages/debts/DebtDetailPage'))
const WealthPage = lazyPage(() => import('./pages/wealth/WealthPage'))
const BillsPage = lazyPage(() => import('./pages/bills/BillsPage'))
const InsightsPage = lazyPage(() => import('./pages/insights/InsightsPage'))
const ChatPage = lazyPage(() => import('./pages/chat/ChatPage'))
const ImportsPage = lazyPage(() => import('./pages/imports/ImportsPage'))
const ImportReviewPage = lazyPage(() => import('./pages/imports/ImportReviewPage'))
const AccountsPage = lazyPage(() => import('./pages/accounts/AccountsPage'))
const SettingsPage = lazyPage(() => import('./pages/settings/SettingsPage'))
const ProjectsPage = lazyPage(() => import('./pages/projects/ProjectsPage'))
const ReviewPage = lazyPage(() => import('./pages/review/ReviewPage'))

function Loading() {
  return (
    <div className="flex min-h-dvh items-center justify-center">
      <Spinner className="h-6 w-6" />
    </div>
  )
}

export default function App() {
  const { session, loading } = useAuth()
  const userId = session?.user.id

  // Capture anything that escapes a component so it lands in the error log
  // and can be exported from Settings, instead of only hitting the console.
  useEffect(() => {
    if (!userId) return
    const onError = (e: ErrorEvent) => {
      void logAppError(userId, 'app', e.message, { source: e.filename, line: e.lineno, stack: e.error?.stack })
    }
    const onRejection = (e: PromiseRejectionEvent) => {
      const r = e.reason
      void logAppError(userId, 'app', r instanceof Error ? r.message : String(r), {
        stack: r instanceof Error ? r.stack : undefined,
      })
    }
    window.addEventListener('error', onError)
    window.addEventListener('unhandledrejection', onRejection)
    return () => {
      window.removeEventListener('error', onError)
      window.removeEventListener('unhandledrejection', onRejection)
    }
  }, [userId])

  if (loading) return <Loading />
  if (!session) return <LoginPage />
  return (
    <Suspense fallback={<Loading />}>
      <Routes>
        <Route element={<AppLayout />}>
          <Route index element={<HomePage />} />
          <Route path="/transactions" element={<TransactionsPage />} />
          <Route path="/budget" element={<BudgetPage />} />
          <Route path="/cashflow" element={<CashflowPage />} />
          <Route path="/debts" element={<DebtsPage />} />
          <Route path="/debts/:id" element={<DebtDetailPage />} />
          <Route path="/wealth" element={<WealthPage />} />
          <Route path="/bills" element={<BillsPage />} />
          <Route path="/insights" element={<InsightsPage />} />
          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="/review" element={<ReviewPage />} />
          <Route path="/chat" element={<ChatPage />} />
          <Route path="/imports" element={<ImportsPage />} />
          <Route path="/imports/:batchId" element={<ImportReviewPage />} />
          <Route path="/accounts" element={<AccountsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </Suspense>
  )
}
