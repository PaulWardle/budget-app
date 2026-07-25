import { Spinner } from '@/components/ui/primitives'
import { useAuth } from '@/context/AuthContext'
import { logAppError } from '@/lib/api'
import { lazy, Suspense, useEffect } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import AppLayout from './components/layout/AppLayout'
import LoginPage from './pages/auth/LoginPage'

const HomePage = lazy(() => import('./pages/home/HomePage'))
const TransactionsPage = lazy(() => import('./pages/transactions/TransactionsPage'))
const BudgetPage = lazy(() => import('./pages/budget/BudgetPage'))
const CashflowPage = lazy(() => import('./pages/cashflow/CashflowPage'))
const DebtsPage = lazy(() => import('./pages/debts/DebtsPage'))
const DebtDetailPage = lazy(() => import('./pages/debts/DebtDetailPage'))
const WealthPage = lazy(() => import('./pages/wealth/WealthPage'))
const BillsPage = lazy(() => import('./pages/bills/BillsPage'))
const InsightsPage = lazy(() => import('./pages/insights/InsightsPage'))
const ChatPage = lazy(() => import('./pages/chat/ChatPage'))
const ImportsPage = lazy(() => import('./pages/imports/ImportsPage'))
const ImportReviewPage = lazy(() => import('./pages/imports/ImportReviewPage'))
const AccountsPage = lazy(() => import('./pages/accounts/AccountsPage'))
const SettingsPage = lazy(() => import('./pages/settings/SettingsPage'))

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
