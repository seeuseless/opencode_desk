type Ask = (message: string) => Promise<boolean>
let ask: Ask | null = null

/** 全局确认框（替代原生 confirm）。需在布局中挂载 <ConfirmHost /> */
export const confirmDialog = (message: string): Promise<boolean> =>
    ask ? ask(message) : Promise.resolve(false)

export const setConfirmAsk = (h: Ask | null) => { ask = h }
