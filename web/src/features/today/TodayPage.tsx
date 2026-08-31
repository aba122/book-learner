import PageHeader from '../../components/PageHeader'

export default function TodayPage() {
  return (
    <div className="mx-auto max-w-4xl px-10 py-12">
      <PageHeader title="今日学习" subtitle="按薄弱重考 → 间隔复习 → 新块攻克的次序推进" />
      <p className="text-sm text-ink-3">今日队列将在 L2-T4 接入。</p>
    </div>
  )
}
