/** 自定义开关（替代原生 checkbox，配色随主题）。disabled 时点击无效且不响应 hover */
export function Switch({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      className={'switch' + (checked ? ' on' : '')}
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
    >
      <span className="knob" />
    </button>
  )
}
