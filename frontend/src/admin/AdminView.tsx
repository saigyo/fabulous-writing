import { useMessages } from '../i18n'

export function AdminView() {
  const m = useMessages()
  return (
    <div className="admin-view">
      <h2>{m.adminUsersTitle}</h2>
    </div>
  )
}
