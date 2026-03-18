export function AdminSubnav({
	active,
}: {
	active: "users" | "ysws" | "redemptions" | "logs" | "settings" | "cache";
}) {
	const item = (href: string, key: typeof active, label: string) => (
		<a
			href={href}
			className={`font-bold px-4 py-2 rounded-lg transition-colors ${
				active === key
					? "text-white bg-white/10"
					: "text-text-muted hover:bg-white/5"
			}`}
		>
			{label}
		</a>
	);

	return (
		<div className="flex gap-4 mb-6 border-b border-white/10 pb-4">
			{item("/admin/users", "users", "Users")}
			{item("/admin/ysws", "ysws", "YSWS")}
			{item("/admin/redemptions", "redemptions", "Redemptions")}
			{item("/admin/logs", "logs", "Logs")}
			{item("/admin/settings", "settings", "Settings")}
			{item("/admin/cache", "cache", "Cache")}
		</div>
	);
}
