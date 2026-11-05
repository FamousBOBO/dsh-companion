/** 极小的 `{{变量}}` 渲染器。
 *
 * 为什么要有它、而不是继续用模板字面量：**人格即数据**
 * （04 §1）。面向模型的文案一旦长在代码里，
 * 改一句话就要发一次版，而且"她到底被怎么交代的"只能靠读 TypeScript。搬进
 * `assets/persona/` 之后，文案是文件、代码是代码。
 *
 * 刻意**不做**的事：没有条件块、没有循环、没有表达式。带控制流的模板语言会把
 * 判断逻辑从代码里搬到字符串里，那比原来更难测；条件仍然由调用方用普通的 `if`
 * 拼装（见 `app/conversation/prompt-composer.ts`）。这里只做一件事：把
 * `{{名字}}` 换成值。
 *
 * 找不到的变量**原样留着**（`{{context}}` 渲染出来还是 `{{context}}`）：
 * 拼错变量名时宁可让它在日志里刺眼地露出来，也不要静默变成空串——空串会让
 * 提示词少一整段而没人发现。
 */

/** `{{name}}`，名字两边允许有空格。 */
const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g

/** 渲染一段模板。`vars` 里没有的键原样保留。 */
export function renderTemplate(template: string, vars: Readonly<Record<string, string>> = {}): string {
  return template.replace(PLACEHOLDER, (whole, name: string) => vars[name] ?? whole)
}

/** 模板里用到了哪些变量（后台展示、以及测试里检查拼写）。 */
export function templateVars(template: string): string[] {
  const found: string[] = []
  for (const match of template.matchAll(PLACEHOLDER)) {
    const name = match[1]
    if (name !== undefined && !found.includes(name)) found.push(name)
  }
  return found
}
