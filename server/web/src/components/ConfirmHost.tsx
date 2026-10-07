import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { setConfirmAsk } from '@/lib/confirm'

/** 全局确认框宿主：在 Admin/Merchant/商城布局各挂载一次 */
export default function ConfirmHost() {
    const [state, setState] = useState<{ message: string; resolve: (v: boolean) => void } | null>(null)

    useEffect(() => {
        setConfirmAsk((message: string) => new Promise<boolean>((resolve) => setState({ message, resolve })))
        return () => setConfirmAsk(null)
    }, [])

    const done = (v: boolean) => {
        state?.resolve(v)
        setState(null)
    }

    return (
        <Dialog open={!!state} onOpenChange={(o) => !o && done(false)}>
            <DialogContent className="max-w-sm">
                <DialogHeader><DialogTitle>操作确认</DialogTitle></DialogHeader>
                <p className="text-sm text-muted-foreground">{state?.message}</p>
                <DialogFooter>
                    <Button variant="outline" onClick={() => done(false)}>取消</Button>
                    <Button onClick={() => done(true)}>确定</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}
