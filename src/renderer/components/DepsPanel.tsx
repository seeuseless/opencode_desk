import { useCallback, useEffect, useState } from 'react'
import { LoaderCircle, Package } from 'lucide-react'
import type { DepItem } from '../../../electron/main/types'

/**
 * 设置 → 依赖：本应用用到的第三方包清单（包名 / 版本号 / 协议）。
 *
 * 数据由主进程从**应用自己的 package.json** 出发、逐个到已安装的包里读真实值：
 *  · 版本号取 node_modules 里实际装上的那个（声明的 `^1.8.0` 只是范围，不是版本）；
 *  · 协议取包自己声明的 license（没写这个字段的包，读它目录里的 LICENSE 文件认 SPDX）。
 * 打包后包里不再带完整 node_modules，此时回落到构建时拍的快照 resources/deps.json，
 * 所以装好的应用里看到的同样是该包真实的协议，不是猜的。
 */
export function DepsPanel() {
  const [items, setItems] = useState<DepItem[]>([])
  const [busy, setBusy] = useState(true)
  const [err, setErr] = useState('')

  const load = useCallback(async () => {
    setBusy(true)
    try {
      setItems(await window.qingniao.depsList())
      setErr('')
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const runtime = items.filter((d) => !d.dev)
  const dev = items.filter((d) => d.dev)

  function group(title: string, tip: string, list: DepItem[]) {
    if (!list.length) return null
    return (
      <div className="dep-group">
        <div className="dep-gtitle">
          {title}
          <span className="chip">{list.length}</span>
        </div>
        <div className="dep-list">
          {list.map((d) => (
            <div className="dep-row" key={d.name} title={`${d.name}@${d.declared} · ${d.license}`}>
              <span className="dep-name">{d.name}</span>
              <span className="dep-ver">{d.version}</span>
              <span className={'dep-lic' + (d.license === '未知' ? ' unk' : '')}>{d.license}</span>
            </div>
          ))}
        </div>
        {tip && <p className="dep-tip">{tip}</p>}
      </div>
    )
  }

  return (
    <section>
      <h3>
        <Package size={15} /> 依赖第三方包
      </h3>
      <p className="sec-tip">
        青鸟本身也站在开源社区肩上。这里列出 package.json 里声明的全部依赖，
        版本号是实际安装的那个，协议取自各包自己声明的 license。
      </p>
      {busy && items.length === 0 && (
        <div className="plist-empty">
          <LoaderCircle size={14} className="spin" /> 正在读取依赖清单…
        </div>
      )}
      {err && <div className="plist-empty">{err}</div>}
      {!busy && !err && items.length === 0 && <div className="plist-empty">没有读到依赖清单</div>}
      {group('运行时依赖', '随安装包一起分发，应用跑起来就要用到。', runtime)}
      {group(
        '开发依赖',
        '只在开发/打包过程中用（编译、类型检查、打包器），不会随安装包分发给用户。',
        dev
      )}
    </section>
  )
}
