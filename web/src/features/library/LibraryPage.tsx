import PageHeader from '../../components/PageHeader'

export default function LibraryPage() {
  return (
    <div className="mx-auto max-w-4xl px-10 py-12">
      <PageHeader title="书架" subtitle="导入 EPUB,选定主攻书" />
      <p className="text-sm text-ink-3">书架与导入向导将在 L2-T5 接入。</p>
    </div>
  )
}
