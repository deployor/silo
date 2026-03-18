export function formatBytes(bytes: number, decimals = 2): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return "0 Bytes";
	const k = 1024;
	const units = ["Bytes", "KB", "MB", "GB", "TB", "PB"];
	const i = Math.min(
		Math.floor(Math.log(bytes) / Math.log(k)),
		units.length - 1,
	);
	const value = bytes / k ** i;
	return `${Number(value.toFixed(decimals))} ${units[i]}`;
}

export function formatDate(value: string | Date | null | undefined): string {
	if (!value) return "-";
	const d = new Date(value);
	if (Number.isNaN(d.getTime())) return "-";
	return d.toLocaleDateString("en-US", {
		year: "numeric",
		month: "short",
		day: "numeric",
	});
}

export function timeAgo(value?: string): string {
	if (!value) return "";
	const date = new Date(value);
	const now = new Date();
	const sec = Math.floor((now.getTime() - date.getTime()) / 1000);
	if (sec < 5) return "now";
	if (sec < 60) return `${sec}s`;
	const min = Math.floor(sec / 60);
	if (min < 60) return `${min}m`;
	const hours = Math.floor(min / 60);
	if (hours < 24) return `${hours}h`;
	const days = Math.floor(hours / 24);
	if (days < 30) return `${days}d`;
	return date.toLocaleDateString();
}
