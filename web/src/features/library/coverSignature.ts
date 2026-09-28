/* 封面签名:首字 + 书脊色条(按书名首字符稳定取三任务色之一;数据色在这里只作装饰)。单独成文件是为了 Fast Refresh 只导出组件的规则 */
const SPINE = ['bg-new', 'bg-review', 'bg-weak']
export const spineColor = (title: string) => SPINE[(title.codePointAt(0) ?? 0) % SPINE.length]
