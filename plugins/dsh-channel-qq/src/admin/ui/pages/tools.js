/** 工具与策略页 = 通用模块页 + 「给机器人下一条指令」卡片。
 *
 * 指令注入等价于学弟在私聊里发一句话：机器人用自己的全部工具去做，做完把结果
 * 私聊发给学弟——端到端验证最方便。这是**会真的发 QQ 消息**的操作，所以提交前
 * 有明确提示，且走审计。
 */

import { el } from '../dom.js'
import { api, authLost, errText } from '../api.js'
import { state } from '../state.js'
import { button, section, setNote } from '../components/card.js'
import { toast } from '../components/toast.js'
import { navigate } from '../router.js'
import { createModulePage } from './module.js'

function promptCard() {
  const card = section({
    title: '给机器人下一条指令',
    icon: 'terminal',
    blurb: '等价于学弟在私聊里发一句话：机器人会用自己的全部工具去做，做完把结果私聊发给学弟。用来做端到端验证最方便。',
  })
  const taId = 'prompt-text'
  const ta = el('textarea', { rows: 4, id: taId, placeholder: '例：调用群列表工具，把群数量和最多的群号发给学弟' })
  card.body.appendChild(el('label', { class: 'vh', for: taId, text: '指令内容' }))
  card.body.appendChild(ta)
  const quick = el('div', { class: 'rowflex', style: 'margin-top:8px' })
  for (const sample of [
    '调用群列表工具，报告群数量',
    '看一下表情库索引了多少张，然后重建一次',
    '把今天的日记文件读出来，总结成三句话发给学弟',
  ]) {
    const chip = button(sample.length > 14 ? `${sample.slice(0, 14)}…` : sample, 'small ghost')
    chip.title = sample
    chip.addEventListener('click', () => { ta.value = sample; ta.focus() })
    quick.appendChild(chip)
  }
  card.body.appendChild(quick)
  const note = el('span', { class: 'inline-note' })
  const send = button('提交指令', 'primary', 'play')
  send.addEventListener('click', async () => {
    const text = ta.value.trim()
    if (text === '') { setNote(note, 'bad', '指令不能为空'); return }
    send.disabled = true
    setNote(note, '', '提交中…')
    const res = await api('/api/prompt', { method: 'POST', body: { text } })
    send.disabled = false
    if (authLost(res)) return
    if (res.status !== 200) { setNote(note, 'bad', `提交失败：${errText(res)}`); toast(`提交失败：${errText(res)}`, 'bad'); return }
    setNote(note, 'ok', '已提交，等机器人跑完（一般 30~60 秒）。结果会私聊发给学弟。')
    toast('已提交，等机器人跑完', 'ok')
    ta.value = ''
  })
  const jump = button('去看运行日志', 'small ghost', 'filetext')
  jump.addEventListener('click', () => navigate('system', 'logs'))
  card.body.appendChild(el('div', { class: 'rowflex', style: 'margin-top:10px' }, [send, jump]))
  card.body.appendChild(note)
  return card.node
}

export default createModulePage('tools', { extras: promptCard })
