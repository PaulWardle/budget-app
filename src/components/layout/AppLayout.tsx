import { Button } from '@/components/ui/primitives'
import { useAuth } from '@/context/AuthContext'
import { useTheme } from '@/context/ThemeContext'
import { cn } from '@/lib/utils'
import {
  CalendarClock,
  CreditCard,
  FileUp,
  Landmark,
  LayoutDashboard,
  Lightbulb,
  List,
  MessageSquare,
  Moon,
  PieChart,
  Settings,
  Sun,
  TrendingUp,
  Wallet,
} from 'lucide-react'
import { NavLink, Outlet } from 'react-router-dom'

const NAV = [
  { to: '/', label: 'Home', icon: LayoutDashboard, mobile: true },
  { to: '/transactions', label: 'Transactions', icon: List, mobile: true },
  { to: '/budget', label: 'Budget', icon: PieChart, mobile: true },
  { to: '/cashflow', label: 'Cashflow', icon: TrendingUp },
  { to: '/debts', label: 'Debts', icon: CreditCard },
  { to: '/wealth', label: 'Wealth', icon: Landmark },
  { to: '/bills', label: 'Bills', icon: CalendarClock },
  { to: '/insights', label: 'Insights', icon: Lightbulb, mobile: true },
  { to: '/chat', label: 'AI Chat', icon: MessageSquare, mobile: true, mobileLabel: 'Chat' },
  { to: '/imports', label: 'Imports', icon: FileUp },
  { to: '/accounts', label: 'Accounts', icon: Wallet },
  { to: '/settings', label: 'Settings', icon: Settings },
]

export default function AppLayout() {
  const { theme, setTheme } = useTheme()
  const { signOut } = useAuth()
  return (
    <div className="flex min-h-dvh">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 hidden w-56 flex-col border-r border-border bg-surface p-3 lg:flex">
        <div className="mb-4 flex items-center gap-2.5 px-2 pt-1">
          <img src="/logo.svg" alt="" className="h-8 w-8 rounded-xl shadow-sm" />
          <span className="text-base font-extrabold tracking-tight">My Money</span>
        </div>
        <nav className="flex-1 space-y-0.5">
          {NAV.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-sm font-medium transition-all',
                  isActive
                    ? 'grad-accent text-white shadow-sm'
                    : 'text-ink-muted hover:bg-surface-2 hover:text-ink',
                )
              }
            >
              <Icon className="h-4 w-4" />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="flex items-center justify-between border-t border-border pt-2">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Toggle theme"
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          >
            {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </Button>
          <Button variant="ghost" size="sm" onClick={signOut}>
            Sign out
          </Button>
        </div>
      </aside>

      {/* Content */}
      <main className="mx-auto w-full max-w-5xl flex-1 px-3 pb-24 pt-4 sm:px-5 lg:pb-8 lg:pl-[240px]">
        <Outlet />
      </main>

      {/* Mobile bottom nav */}
      <nav className="fixed inset-x-0 bottom-0 z-40 flex border-t border-border bg-surface/90 backdrop-blur-lg pb-[env(safe-area-inset-bottom)] lg:hidden">
        {NAV.filter((n) => n.mobile).map(({ to, label, icon: Icon, mobileLabel }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            className={({ isActive }) =>
              cn(
                'flex flex-1 flex-col items-center gap-0.5 py-2 text-[10px] font-semibold transition-colors',
                isActive ? 'text-accent' : 'text-ink-faint',
              )
            }
          >
            <Icon className="h-5 w-5" />
            {mobileLabel ?? label}
          </NavLink>
        ))}
      </nav>
    </div>
  )
}
