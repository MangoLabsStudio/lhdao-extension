import type { CampaignTaskCache } from '@/lib/storage'
import { MetadataBadge } from './MetadataBadge'
import { SubmitButton } from './SubmitButton'

interface Props {
  tasks: CampaignTaskCache[]
  /** 是否是焦点推文(详情页才挂 SubmitButton,timeline 只挂 Badge) */
  isFocal: boolean
}

/**
 * 顶部右上角 (3-dot 菜单旁) 的整组:Badge + (焦点推文才有的) SubmitButton。
 *
 * Twitter 详情页头部右侧有空位 (订阅按钮位置或它的左侧),把这两个组件塞过去
 * 比塞在底部 action row 更显眼,而且与"该推文有 Lighthouse 任务"的语义
 * 联系更紧密。
 */
export function TopHeaderGroup({ tasks, isFocal }: Props) {
  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        verticalAlign: 'middle',
      }}
    >
      <MetadataBadge tasks={tasks} />
      {isFocal && <SubmitButton tasks={tasks} />}
    </div>
  )
}
