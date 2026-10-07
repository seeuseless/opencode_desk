import { Badge } from '@/components/ui/badge'

/**
 * 模型/上游/密钥 三处的状态徽标，口径统一在这里：
 * ok=可用、error=失败、unknown=未检测、unmatched=还没有上游提供这个模型名。
 */
export function AiStatusBadge({ status, latency }: { status: string; latency?: number | null }) {
    const map: Record<string, { text: string; variant: 'success' | 'destructive' | 'secondary' | 'warning' }> = {
        ok: { text: '可用', variant: 'success' },
        error: { text: '失败', variant: 'destructive' },
        unknown: { text: '未检测', variant: 'secondary' },
        unmatched: { text: '未匹配', variant: 'warning' },
    }
    const it = map[status] ?? map.unknown

    return (
        <span className="inline-flex items-center gap-1.5">
            <Badge variant={it.variant}>{it.text}</Badge>
            {status === 'ok' && latency ? <span className="text-xs text-muted-foreground">{latency}ms</span> : null}
        </span>
    )
}
