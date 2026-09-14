import {
  Activity,
  AlertTriangle,
  Archive,
  BarChart3,
  Bell,
  Bot,
  Box,
  Calendar,
  Check,
  CheckCircle2,
  ChevronRight,
  Circle,
  Clock,
  Cloud,
  Code,
  Cpu,
  Database,
  DollarSign,
  Download,
  ExternalLink,
  Eye,
  FileText,
  Filter,
  Folder,
  Gauge,
  GitBranch,
  Globe,
  Hash,
  Heart,
  Info,
  Key,
  Layers,
  LayoutDashboard,
  Link,
  List,
  Lock,
  Mail,
  MessageSquare,
  MessagesSquare,
  Network,
  Package,
  PieChart,
  Play,
  Plug,
  Plus,
  RefreshCw,
  Rocket,
  Search,
  Server,
  Settings,
  Shield,
  Sparkles,
  Star,
  Table2,
  Tag,
  Terminal,
  Timer,
  Trash2,
  TrendingUp,
  Upload,
  User,
  Users,
  Wallet,
  Wrench,
  X,
  Zap,
} from 'lucide-react';

/**
 * The icons a plugin may name. A fixed map rather than the whole of lucide,
 * because a namespace import would put every icon in the app's bundle and the
 * icons here are the ones a plugin page has a use for.
 *
 * Keyed in kebab-case, which is how the icons are named upstream and in a
 * plugin's manifest.
 */
export const PLUGIN_ICONS = {
  activity: Activity,
  'alert-triangle': AlertTriangle,
  archive: Archive,
  'bar-chart': BarChart3,
  bell: Bell,
  bot: Bot,
  box: Box,
  calendar: Calendar,
  check: Check,
  'check-circle': CheckCircle2,
  'chevron-right': ChevronRight,
  circle: Circle,
  clock: Clock,
  cloud: Cloud,
  code: Code,
  cpu: Cpu,
  database: Database,
  'dollar-sign': DollarSign,
  download: Download,
  'external-link': ExternalLink,
  eye: Eye,
  'file-text': FileText,
  filter: Filter,
  folder: Folder,
  gauge: Gauge,
  'git-branch': GitBranch,
  globe: Globe,
  hash: Hash,
  heart: Heart,
  info: Info,
  key: Key,
  layers: Layers,
  'layout-dashboard': LayoutDashboard,
  link: Link,
  list: List,
  lock: Lock,
  mail: Mail,
  'message-square': MessageSquare,
  'messages-square': MessagesSquare,
  network: Network,
  package: Package,
  'pie-chart': PieChart,
  play: Play,
  plug: Plug,
  plus: Plus,
  'refresh-cw': RefreshCw,
  rocket: Rocket,
  search: Search,
  server: Server,
  settings: Settings,
  shield: Shield,
  sparkles: Sparkles,
  star: Star,
  table: Table2,
  tag: Tag,
  terminal: Terminal,
  timer: Timer,
  trash: Trash2,
  'trending-up': TrendingUp,
  upload: Upload,
  user: User,
  users: Users,
  wallet: Wallet,
  wrench: Wrench,
  x: X,
  zap: Zap,
} as const;

export type PluginIconName = keyof typeof PLUGIN_ICONS;

/** The icon a plugin gets when it names one this app does not carry. */
export const FALLBACK_ICON = Plug;

export function iconFor(name: string | undefined) {
  if (!name) return FALLBACK_ICON;
  return PLUGIN_ICONS[name as PluginIconName] ?? FALLBACK_ICON;
}

export interface IconProps {
  name: string;
  /** Matches the sizes the rest of the UI uses. */
  size?: 'sm' | 'md' | 'lg';
}

const SIZES = { sm: 'size-3', md: 'size-4', lg: 'size-5' } as const;

/**
 * An icon named by string, for a plugin page. A name rather than an import,
 * so a page needs no second import specifier and an unknown name renders a
 * generic glyph instead of failing.
 */
export function Icon({ name, size = 'md' }: IconProps) {
  const Glyph = iconFor(name);
  return <Glyph className={SIZES[size]} />;
}
