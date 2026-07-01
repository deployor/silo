import type { ReactElement } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MdDeleteForever, MdOpenInNew } from "react-icons/md";
import { AdminSubnav } from "../components/AdminSubnav";
import { AppShell } from "../components/AppShell";
import { Modal } from "../components/ui/Modal";
import { fetchJson, fetchText } from "../shared/api/http";
import type { AppBootstrap, FrontendUser } from "../shared/types/app";
import { formatBytes } from "../shared/utils/format";

type UserRow = {
	id: string;
	email: string;
	slackId?: string | null;
	storageLimitBytes: number;
	storageUsageBytes: number;
	egressLimitBytes: number | null;
	egressBytes: number;
	isAdmin: boolean;
	isImmortal: boolean;
	isLocked: boolean;
	lockReason?: string | null;
	markedAsOverAge?: boolean;
	dataExported?: boolean;
	filesDeleted?: boolean;
	overAgeGracePeriodEndsAt?: string | null;
};

type BucketRow = {
	id: string;
	name: string;
	totalBytes: number;
	isPaused?: boolean;
	pauseReason?: string | null;
};

type KeyRow = {
	id: string;
	accessKey: string;
	note?: string | null;
	isPaused?: boolean;
	pauseReason?: string | null;
};

type ConfirmActionState = {
	title: string;
	message: string;
	confirmLabel: string;
	confirmClassName?: string;
	onConfirm: () => Promise<void>;
};

type ReasonModalState = {
	title: string;
	label: string;
	placeholder?: string;
	initialValue?: string;
	confirmLabel: string;
	onSubmit: (value: string) => Promise<void>;
};

type KeyNoteModalState = {
	keyId: string;
	accessKey: string;
	note: string;
};

type FileRow = {
	key: string;
	size: number;
	url: string;
};

type BucketDetails = {
	id: string;
	name: string;
	userId: string;
	isPaused?: boolean;
	pauseReason?: string | null;
	keys: KeyRow[];
	files: FileRow[];
};

type UsersResponse = {
	users: UserRow[];
	total: number;
};

const BYTE_UNITS = [
	{ label: "Bytes", value: 1 },
	{ label: "KB", value: 1024 },
	{ label: "MB", value: 1024 ** 2 },
	{ label: "GB", value: 1024 ** 3 },
	{ label: "TB", value: 1024 ** 4 },
];

function toAmountUnit(bytes: number): { amount: number; unit: number } {
	if (!Number.isFinite(bytes) || bytes <= 0) return { amount: 0, unit: 1 };
	const idx = Math.min(
		Math.floor(Math.log(bytes) / Math.log(1024)),
		BYTE_UNITS.length - 1,
	);
	const unit = BYTE_UNITS[idx]?.value || 1;
	return { amount: Number((bytes / unit).toFixed(2)), unit };
}

function toBytes(amount: number, unit: number): number {
	if (!Number.isFinite(amount) || !Number.isFinite(unit)) return 0;
	return Math.floor(Math.max(0, amount) * unit);
}

function StatusBadges({ user }: { user: UserRow }) {
	const now = new Date();
	const graceEnd = user.overAgeGracePeriodEndsAt
		? new Date(user.overAgeGracePeriodEndsAt)
		: null;
	const isExpired = Boolean(graceEnd && now > graceEnd);
	const timeUntil = graceEnd
		? Math.ceil((graceEnd.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
		: 0;
	const dateStr = graceEnd ? graceEnd.toLocaleDateString() : "";

	if (user.filesDeleted && user.dataExported) {
		return (
			<span
				title="User successfully exported data. Files have been deleted."
				className="bg-emerald-500/20 text-emerald-400 px-2 py-0.5 rounded text-xs font-bold border border-emerald-500/30"
			>
				MIGRATED
			</span>
		);
	}

	if (user.filesDeleted && !user.dataExported) {
		return (
			<span
				title="Files deleted. User did NOT export data in time."
				className="bg-red-500/20 text-red-400 px-2 py-0.5 rounded text-xs font-bold border border-red-500/30"
			>
				TOO LATE
			</span>
		);
	}

	if (user.markedAsOverAge && user.dataExported) {
		return (
			<span
				title="User has initiated export. Account frozen. Files pending deletion."
				className="bg-cyan-500/20 text-cyan-400 px-2 py-0.5 rounded text-xs font-bold border border-cyan-500/30"
			>
				EXPORTED
			</span>
		);
	}

	if (user.markedAsOverAge && isExpired) {
		return (
			<span
				title={`Grace period expired on ${dateStr}. Pending deletion.`}
				className="bg-red-500/20 text-red-400 px-2 py-0.5 rounded text-xs font-bold border border-red-500/30"
			>
				EXPIRED
			</span>
		);
	}

	if (user.markedAsOverAge) {
		return (
			<span
				title={`In Grace Period. Ends: ${dateStr} (${timeUntil} days left). User has NOT exported yet.`}
				className="bg-yellow-500/20 text-yellow-400 px-2 py-0.5 rounded text-xs font-bold border border-yellow-500/30"
			>
				NO EXPORT
			</span>
		);
	}

	const badges: ReactElement[] = [];

	if (user.isLocked) {
		badges.push(
			<span
				key="locked"
				title={`Account Manually Locked${user.lockReason ? `: ${user.lockReason}` : ""}`}
				className="bg-red-500/20 text-hc-red px-2 py-0.5 rounded text-xs font-bold border border-red-500/30"
			>
				LOCKED
			</span>,
		);
	}

	if (user.isImmortal) {
		badges.push(
			<span
				key="immortal"
				title="Immortal: Unlimited Quota, No Aging, No Locks"
				className="bg-amber-500/20 text-amber-400 px-2 py-0.5 rounded text-xs font-bold border border-amber-500/30"
			>
				IMMORTAL
			</span>,
		);
	}

	if (user.isAdmin) {
		badges.push(
			<span
				key="admin"
				title="Full Admin Access"
				className="bg-purple-500/20 text-purple-400 px-2 py-0.5 rounded text-xs font-bold border border-purple-500/30"
			>
				ADMIN
			</span>,
		);
	}

	if (badges.length === 0) {
		return (
			<span
				title="Normal Active Account"
				className="bg-white/10 text-white px-2 py-0.5 rounded text-xs font-bold border border-white/20"
			>
				ACTIVE
			</span>
		);
	}

	return <div className="flex gap-1 flex-wrap">{badges}</div>;
}

function Toggle({
	checked,
	onChange,
	color,
	label,
	disabled,
}: {
	checked: boolean;
	onChange: (checked: boolean) => void;
	color: "red" | "green" | "amber";
	label: string;
	disabled?: boolean;
}) {
	const colorClass =
		color === "red"
			? "peer-checked:bg-hc-red peer-focus:ring-hc-red"
			: color === "green"
				? "peer-checked:bg-emerald-500 peer-focus:ring-emerald-500"
				: "peer-checked:bg-amber-500 peer-focus:ring-amber-500";

	return (
		<label
			className={`inline-flex items-center ${disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer"}`}
		>
			<input
				type="checkbox"
				className="sr-only peer"
				checked={checked}
				disabled={disabled}
				onChange={(e) => onChange(e.target.checked)}
			/>
			<div
				className={`relative w-11 h-6 bg-white/10 rounded-full peer-focus:outline-none peer-focus:ring-2 ${colorClass} peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-0.5 after:start-0.5 after:bg-white after:border after:border-gray-300 after:rounded-full after:h-5 after:w-5 after:transition-all`}
			/>
			<span className="ms-3 text-sm font-medium text-text-muted peer-checked:text-white">
				{label}
			</span>
		</label>
	);
}

export function AdminUsersPage({ bootstrap }: { bootstrap: AppBootstrap }) {
	const p = bootstrap.props as {
		user?: FrontendUser | null;
		pageTitle?: string;
	};

	const initialSearch =
		typeof window !== "undefined"
			? new URLSearchParams(window.location.search).get("search") || ""
			: "";

	const [search, setSearch] = useState(initialSearch);
	const [adminsOnly, setAdminsOnly] = useState(false);
	const [users, setUsers] = useState<UserRow[]>([]);
	const [offset, setOffset] = useState(0);
	const [total, setTotal] = useState(0);
	const [loading, setLoading] = useState(false);

	const [selected, setSelected] = useState<UserRow | null>(null);
	const [selectedBuckets, setSelectedBuckets] = useState<BucketRow[]>([]);
	const [selectedBucketDetails, setSelectedBucketDetails] =
		useState<BucketDetails | null>(null);

	const [storageAmount, setStorageAmount] = useState(0);
	const [storageUnit, setStorageUnit] = useState(1024 ** 3);
	const [egressMode, setEgressMode] = useState<
		"default" | "unlimited" | "custom"
	>("default");
	const [egressAmount, setEgressAmount] = useState(0);
	const [egressUnit, setEgressUnit] = useState(1024 ** 3);
	const loadingRef = useRef(false);
	const lastRequestKeyRef = useRef("");
	const lastRequestAtRef = useRef(0);
	const searchRef = useRef(search);
	const adminsOnlyRef = useRef(adminsOnly);
	const offsetRef = useRef(offset);
	const [userActionLoading, setUserActionLoading] = useState<string | null>(
		null,
	);
	const [bucketActionLoading, setBucketActionLoading] = useState<string | null>(
		null,
	);
	const [confirmAction, setConfirmAction] = useState<ConfirmActionState | null>(
		null,
	);
	const [confirmLoading, setConfirmLoading] = useState(false);
	const [reasonModal, setReasonModal] = useState<ReasonModalState | null>(null);
	const [reasonValue, setReasonValue] = useState("");
	const [reasonLoading, setReasonLoading] = useState(false);
	const [keyNoteModal, setKeyNoteModal] = useState<KeyNoteModalState | null>(
		null,
	);
	const [keyNoteLoading, setKeyNoteLoading] = useState(false);

	const limit = 50;

	useEffect(() => {
		searchRef.current = search;
	}, [search]);

	useEffect(() => {
		adminsOnlyRef.current = adminsOnly;
	}, [adminsOnly]);

	useEffect(() => {
		offsetRef.current = offset;
	}, [offset]);

	const loadUsers = useCallback(
		async (
			reset = true,
			overrides?: {
				offset?: number;
				search?: string;
				adminsOnly?: boolean;
				force?: boolean;
			},
		): Promise<UsersResponse | null> => {
			if (loadingRef.current) return null;
			loadingRef.current = true;
			setLoading(true);
			const nextOffset = reset ? 0 : (overrides?.offset ?? offsetRef.current);
			const nextSearch = overrides?.search ?? searchRef.current;
			const nextAdminsOnly = overrides?.adminsOnly ?? adminsOnlyRef.current;
			const q = new URLSearchParams({
				limit: String(limit),
				offset: String(nextOffset),
				search: nextSearch,
				adminsOnly: String(nextAdminsOnly),
			});
			const requestKey = q.toString();
			const now = Date.now();
			const shouldDedupe =
				!overrides?.force &&
				requestKey === lastRequestKeyRef.current &&
				now - lastRequestAtRef.current < 1200;

			if (shouldDedupe) {
				loadingRef.current = false;
				setLoading(false);
				return null;
			}

			lastRequestKeyRef.current = requestKey;
			lastRequestAtRef.current = now;
			try {
				const data = await fetchJson<UsersResponse>(
					`/api/admin/users?${q.toString()}`,
				);
				setTotal(data.total || 0);
				if (reset) {
					setUsers(data.users || []);
					const next = (data.users || []).length;
					setOffset(next);
					offsetRef.current = next;
				} else {
					setUsers((prev) => [...prev, ...(data.users || [])]);
					const next = nextOffset + (data.users || []).length;
					setOffset(next);
					offsetRef.current = next;
				}
				return data;
			} catch (e) {
				window.alert(e instanceof Error ? e.message : "Failed to load users");
				return null;
			} finally {
				loadingRef.current = false;
				setLoading(false);
			}
		},
		[],
	);

	useEffect(() => {
		loadUsers(true);
	}, [loadUsers]);

	useEffect(() => {
		if (!selected) return;

		const storage = toAmountUnit(selected.storageLimitBytes);
		setStorageAmount(storage.amount);
		setStorageUnit(storage.unit > 1024 ** 4 ? 1024 ** 4 : storage.unit);

		if (
			selected.egressLimitBytes === null ||
			selected.egressLimitBytes === undefined
		) {
			setEgressMode("default");
			setEgressAmount(0);
			setEgressUnit(1024 ** 3);
		} else if (selected.egressLimitBytes === -1) {
			setEgressMode("unlimited");
			setEgressAmount(0);
			setEgressUnit(1024 ** 3);
		} else {
			setEgressMode("custom");
			const egress = toAmountUnit(selected.egressLimitBytes);
			setEgressAmount(egress.amount);
			setEgressUnit(egress.unit > 1024 ** 4 ? 1024 ** 4 : egress.unit);
		}
	}, [selected]);

	const selectedStoragePercent = useMemo(() => {
		if (!selected?.storageLimitBytes) return 0;
		return Math.min(
			100,
			(selected.storageUsageBytes / selected.storageLimitBytes) * 100,
		);
	}, [selected]);

	const selectedEgressPercent = useMemo(() => {
		if (!selected?.egressLimitBytes || selected.egressLimitBytes <= 0) return 0;
		return Math.min(
			100,
			(selected.egressBytes / selected.egressLimitBytes) * 100,
		);
	}, [selected]);

	const openUser = async (u: UserRow) => {
		setSelected(u);
		try {
			const buckets = await fetchJson<BucketRow[]>(
				`/api/admin/users/${u.id}/buckets`,
			);
			setSelectedBuckets(buckets || []);
		} catch (e) {
			window.alert(
				e instanceof Error ? e.message : "Failed to load user buckets",
			);
		}
	};

	const refreshSelectedBuckets = useCallback(async () => {
		if (!selected) return;
		const buckets = await fetchJson<BucketRow[]>(
			`/api/admin/users/${selected.id}/buckets`,
		);
		setSelectedBuckets(buckets || []);
	}, [selected]);

	const patchUser = async (path: string, body: unknown) => {
		if (!selected) return;
		setUserActionLoading(path);
		try {
			await fetchText(`/api/admin/users/${selected.id}/${path}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			const updated = await loadUsers(true, { force: true });
			if (updated) {
				const refreshed =
					updated.users.find((u) => u.id === selected.id) || null;
				setSelected(refreshed);
				if (refreshed) {
					const buckets = await fetchJson<BucketRow[]>(
						`/api/admin/users/${refreshed.id}/buckets`,
					);
					setSelectedBuckets(buckets || []);
				}
			}
		} catch (e) {
			window.alert(e instanceof Error ? e.message : "Update failed");
		} finally {
			setUserActionLoading(null);
		}
	};

	const updateStorageQuota = async () => {
		if (!selected) return;
		const next = toBytes(storageAmount, storageUnit);
		await patchUser("quota", { storageLimitBytes: next });
		window.alert(`Storage quota updated to ${formatBytes(next)}`);
	};

	const updateEgressQuota = async () => {
		if (!selected) return;
		let next: number | null = null;
		if (egressMode === "unlimited") next = -1;
		if (egressMode === "custom") next = toBytes(egressAmount, egressUnit);
		await patchUser("quota", { egressLimitBytes: next });
		window.alert(
			egressMode === "default"
				? "Egress limit set to Default (formula)"
				: egressMode === "unlimited"
					? "Egress limit set to Unlimited"
					: `Egress limit updated to ${formatBytes(next || 0)}`,
		);
	};

	const toggleLock = async (isLocked: boolean) => {
		setSelected((prev) => (prev ? { ...prev, isLocked } : prev));
		if (!isLocked) {
			await patchUser("lock", { isLocked, lockReason: null });
			return;
		}
		setReasonValue("");
		setReasonModal({
			title: "Lock Account",
			label: "Reason",
			placeholder: "Optional reason shown to admins",
			confirmLabel: "Lock Account",
			onSubmit: async (value) => {
				await patchUser("lock", { isLocked, lockReason: value || null });
			},
		});
	};

	const toggleImmortal = async (isImmortal: boolean) => {
		setSelected((prev) => (prev ? { ...prev, isImmortal } : prev));
		await patchUser("immortal", { isImmortal });
	};

	const markAsOverAge = async () => {
		if (!selected) return;
		setConfirmAction({
			title: "Mark User as Over-Age",
			message: `Mark ${selected.email} as over-age? This will notify them via Slack and start the 2-month deletion countdown.`,
			confirmLabel: "Mark Over-Age",
			confirmClassName: "bg-hc-red hover:bg-red-600 text-white",
			onConfirm: async () => {
				setUserActionLoading("age-out");
				try {
					await fetchText(`/api/admin/users/${selected.id}/age-out`, {
						method: "POST",
					});
					setSelected(null);
					await loadUsers(true, { force: true });
				} finally {
					setUserActionLoading(null);
				}
			},
		});
	};

	const startImpersonation = async () => {
		if (!selected) return;
		setConfirmAction({
			title: "Impersonate User",
			message: `Impersonate ${selected.email}? This will switch your current session immediately.`,
			confirmLabel: "Impersonate",
			confirmClassName:
				"bg-yellow-500/20 hover:bg-yellow-500/30 text-yellow-200 border-yellow-500/30",
			onConfirm: async () => {
				setUserActionLoading("impersonate");
				try {
					await fetchText("/api/admin/impersonate", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ userId: selected.id }),
					});
					window.location.href = "/";
				} finally {
					setUserActionLoading(null);
				}
			},
		});
	};

	const openBucketModal = async (bucketName: string) => {
		const details = await fetchJson<BucketDetails>(
			`/api/admin/buckets/${bucketName}`,
		);
		setSelectedBucketDetails(details);
	};

	const closeBucketModal = () => setSelectedBucketDetails(null);

	const refreshBucketModal = async () => {
		if (!selectedBucketDetails) return;
		const details = await fetchJson<BucketDetails>(
			`/api/admin/buckets/${selectedBucketDetails.name}`,
		);
		setSelectedBucketDetails(details);
		await refreshSelectedBuckets();
	};

	const deleteBucketAdmin = async (reset = false) => {
		if (!selectedBucketDetails) return;
		const message = reset
			? "Empty this bucket? This will delete ALL files in it."
			: "Delete this bucket and ALL data?";
		setConfirmAction({
			title: reset ? "Empty Bucket" : "Delete Bucket",
			message,
			confirmLabel: reset ? "Empty Bucket" : "Delete Bucket",
			confirmClassName: "bg-hc-red hover:bg-red-600 text-white",
			onConfirm: async () => {
				setBucketActionLoading(reset ? "bucket-empty" : "bucket-delete");
				try {
					await fetchText(
						`/api/admin/buckets/${selectedBucketDetails.name}${reset ? "?reset=true" : ""}`,
						{ method: "DELETE" },
					);
					closeBucketModal();
					await refreshSelectedBuckets();
				} finally {
					setBucketActionLoading(null);
				}
			},
		});
	};

	const resetBucketCorsAdmin = async () => {
		if (!selectedBucketDetails) return;
		setConfirmAction({
			title: "Reset Bucket CORS",
			message: "Reset CORS configuration for this bucket?",
			confirmLabel: "Reset CORS",
			confirmClassName: "bg-white/10 hover:bg-white/20 text-white",
			onConfirm: async () => {
				setBucketActionLoading("cors-reset");
				try {
					await fetchText(
						`/api/admin/buckets/${selectedBucketDetails.name}/cors`,
						{
							method: "DELETE",
						},
					);
				} finally {
					setBucketActionLoading(null);
				}
			},
		});
	};

	const toggleBucketPause = async (isPaused: boolean) => {
		if (!selectedBucketDetails) return;
		if (!isPaused) {
			setBucketActionLoading("pause");
			await fetchText(
				`/api/admin/buckets/${selectedBucketDetails.name}/pause`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ isPaused, pauseReason: null }),
				},
			);
			await refreshBucketModal();
			setBucketActionLoading(null);
			return;
		}
		setReasonValue("");
		setReasonModal({
			title: "Pause Bucket",
			label: "Pause reason",
			placeholder: "Optional reason visible in admin UI",
			confirmLabel: "Pause Bucket",
			onSubmit: async (value) => {
				setBucketActionLoading("pause");
				try {
					await fetchText(
						`/api/admin/buckets/${selectedBucketDetails.name}/pause`,
						{
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({ isPaused, pauseReason: value || null }),
						},
					);
					await refreshBucketModal();
				} finally {
					setBucketActionLoading(null);
				}
			},
		});
	};

	const toggleKeyPause = async (keyId: string, isPaused: boolean) => {
		if (!selectedBucketDetails) return;
		if (!isPaused) {
			setBucketActionLoading(`key-${keyId}`);
			await fetchText(`/api/admin/keys/${keyId}/pause`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ isPaused, pauseReason: null }),
			});
			await refreshBucketModal();
			setBucketActionLoading(null);
			return;
		}
		setReasonValue("");
		setReasonModal({
			title: "Pause Key",
			label: "Pause reason",
			placeholder: "Optional reason visible in admin UI",
			confirmLabel: "Pause Key",
			onSubmit: async (value) => {
				setBucketActionLoading(`key-${keyId}`);
				try {
					await fetchText(`/api/admin/keys/${keyId}/pause`, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ isPaused, pauseReason: value || null }),
					});
					await refreshBucketModal();
				} finally {
					setBucketActionLoading(null);
				}
			},
		});
	};

	const deleteKeyAdmin = async (keyId: string) => {
		setConfirmAction({
			title: "Delete Key",
			message:
				"Delete this key? Any clients using it will immediately lose access.",
			confirmLabel: "Delete Key",
			confirmClassName: "bg-hc-red hover:bg-red-600 text-white",
			onConfirm: async () => {
				setBucketActionLoading(`key-del-${keyId}`);
				try {
					await fetchText(`/api/admin/keys/${keyId}`, { method: "DELETE" });
					await refreshBucketModal();
				} finally {
					setBucketActionLoading(null);
				}
			},
		});
	};

	const deleteFileAdmin = async (key: string) => {
		if (!selectedBucketDetails) return;
		setConfirmAction({
			title: "Delete File",
			message: `Delete file ${key}? This cannot be undone.`,
			confirmLabel: "Delete File",
			confirmClassName: "bg-hc-red hover:bg-red-600 text-white",
			onConfirm: async () => {
				setBucketActionLoading(`file-del-${key}`);
				try {
					await fetchText(
						`/api/admin/buckets/${selectedBucketDetails.name}/files?key=${encodeURIComponent(key)}`,
						{ method: "DELETE" },
					);
					await refreshBucketModal();
				} finally {
					setBucketActionLoading(null);
				}
			},
		});
	};

	const openKeyNoteModal = (key: KeyRow) => {
		setKeyNoteModal({
			keyId: key.id,
			accessKey: key.accessKey,
			note: key.note || "",
		});
	};

	const saveKeyNote = async () => {
		if (!keyNoteModal) return;
		setKeyNoteLoading(true);
		try {
			await fetchText(`/api/admin/keys/${keyNoteModal.keyId}/note`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ note: keyNoteModal.note }),
			});
			await refreshBucketModal();
			setKeyNoteModal(null);
		} finally {
			setKeyNoteLoading(false);
		}
	};

	const isQuotaLoading = userActionLoading === "quota";
	const isImpersonating = userActionLoading === "impersonate";
	const isAgeOutLoading = userActionLoading === "age-out";

	return (
		<AppShell
			title={bootstrap.title}
			user={p.user || null}
			pageTitle={p.pageTitle || "ADMIN"}
			config={bootstrap.config}
		>
			<AdminSubnav active="users" />

			<div className="bg-hc-dark rounded-3xl border border-white/10 overflow-hidden card-shadow mb-8">
				<div className="p-6 border-b border-white/10 flex justify-between items-center gap-4 flex-wrap">
					<div>
						<h2 className="text-xl font-bold text-white">Users</h2>
						<p className="text-text-muted text-sm mt-1">
							Manage all users, quotas, and access.
						</p>
					</div>
					<div className="flex items-center gap-3 flex-wrap">
						<div className="text-xs text-text-muted font-mono">
							Showing {offset} of {total} users
						</div>
						<input
							type="text"
							value={search}
							onChange={(e) => setSearch(e.target.value)}
							onKeyDown={(e) => e.key === "Enter" && loadUsers(true)}
							placeholder="Search users..."
							className="bg-black/30 border border-white/10 rounded-xl px-4 py-2 text-white focus:outline-none focus:border-hc-red text-sm w-64"
						/>
						<label className="inline-flex items-center cursor-pointer">
							<input
								type="checkbox"
								checked={adminsOnly}
								onChange={(e) => {
									const checked = e.target.checked;
									setAdminsOnly(checked);
									void loadUsers(true, { adminsOnly: checked });
								}}
								className="sr-only peer"
							/>
							<div className="relative w-9 h-5 bg-white/10 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-hc-red rounded-full peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-0.5 after:start-0.5 after:bg-white after:border after:border-gray-300 after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-hc-red" />
							<span className="ms-2 text-xs font-medium text-text-muted peer-checked:text-white">
								Admins Only
							</span>
						</label>
						<button
							type="button"
							onClick={() => loadUsers(true)}
							className="bg-white/5 hover:bg-white/10 border border-white/10 text-white px-3 py-2 rounded-lg text-sm font-bold"
						>
							Search
						</button>
					</div>
				</div>

				<div className="overflow-x-auto">
					<table className="w-full text-left text-sm">
						<thead className="bg-white/5 text-text-muted font-bold uppercase text-xs tracking-wider">
							<tr>
								<th className="px-6 py-4">User</th>
								<th className="px-6 py-4">Slack ID</th>
								<th className="px-6 py-4">Storage</th>
								<th className="px-6 py-4">Monthly Egress</th>
								<th className="px-6 py-4">Status</th>
								<th className="px-6 py-4 text-right">Actions</th>
							</tr>
						</thead>
						<tbody className="divide-y divide-white/5">
							{users.map((u) => (
								<tr
									key={u.id}
									className="hover:bg-white/5 transition-colors cursor-pointer"
									onClick={() => openUser(u)}
								>
									<td className="px-6 py-4 font-medium text-white">
										<div className="flex items-center gap-3">
											{u.slackId ? (
												<img
													src={`https://cachet.dunkirk.sh/users/${u.slackId}/r`}
													className="w-8 h-8 rounded-full bg-white/10"
													alt=""
												/>
											) : (
												<div className="w-8 h-8 rounded-full bg-white/10 flex items-center justify-center text-xs text-text-muted">
													?
												</div>
											)}
											<div>
												<div>{u.email}</div>
												<div className="text-xs text-text-muted font-mono">
													{u.id}
												</div>
											</div>
										</div>
									</td>
									<td className="px-6 py-4 font-mono text-xs text-text-muted">
										{u.slackId || "-"}
									</td>
									<td className="px-6 py-4">
										<div className="text-xs font-mono">
											<span className="text-white">
												{formatBytes(u.storageUsageBytes)}
											</span>
											<span className="text-text-muted">
												{" "}
												/ {formatBytes(u.storageLimitBytes)}
											</span>
										</div>
										<div className="w-24 bg-white/10 rounded-full h-1.5 mt-1 overflow-hidden">
											<div
												className="bg-hc-red h-1.5 rounded-full"
												style={{
													width: `${Math.min((u.storageUsageBytes / (u.storageLimitBytes || 1)) * 100, 100)}%`,
												}}
											/>
										</div>
									</td>
									<td className="px-6 py-4">
										<div className="text-xs font-mono">
											<span className="text-white">
												{formatBytes(u.egressBytes)}
											</span>
											<span className="text-text-muted">
												{" "}
												/{" "}
												{u.egressLimitBytes === null
													? "Default (formula)"
													: u.egressLimitBytes === -1
														? "Unlimited"
														: formatBytes(u.egressLimitBytes)}
											</span>
										</div>
										<div className="w-24 bg-white/10 rounded-full h-1.5 mt-1 overflow-hidden">
											<div
												className="bg-hc-red h-1.5 rounded-full"
												style={{
													width:
														u.egressLimitBytes === -1 ||
														u.egressLimitBytes === null
															? "0%"
															: `${Math.min((u.egressBytes / (u.egressLimitBytes || 1)) * 100, 100)}%`,
												}}
											/>
										</div>
									</td>
									<td className="px-6 py-4">
										<StatusBadges user={u} />
									</td>
									<td className="px-6 py-4 text-right">
										<button
											type="button"
											className="text-hc-red hover:text-hc-red text-xs font-bold uppercase tracking-wider"
										>
											Manage
										</button>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>

				<div className="p-4 border-t border-white/10 flex justify-center">
					{!loading && offset < total ? (
						<button
							type="button"
							onClick={() => loadUsers(false, { offset })}
							className="text-text-muted hover:text-white text-sm font-bold"
						>
							Load More
						</button>
					) : null}
					{loading ? (
						<span className="text-text-muted text-sm">Loading...</span>
					) : null}
				</div>
			</div>

			<Modal
				open={!!selected}
				onClose={() => setSelected(null)}
				title={selected?.id || "User Details"}
				className="max-w-4xl p-8"
			>
				{selected ? (
					<div className="space-y-6">
						<p className="text-text-muted text-sm -mt-4 font-mono">
							{selected.email}
						</p>

						<div className="grid grid-cols-1 md:grid-cols-2 gap-6">
							<div className="bg-black/30 p-6 rounded-xl border border-white/10">
								<h4 className="text-white font-bold mb-4">Storage Quota</h4>
								<div className="flex gap-2 items-center">
									<input
										type="number"
										step="0.01"
										min={0}
										value={storageAmount}
										onChange={(e) => setStorageAmount(Number(e.target.value))}
										className="bg-black/50 border border-white/10 rounded-lg px-3 py-2 text-white w-full"
									/>
									<select
										value={storageUnit}
										onChange={(e) => setStorageUnit(Number(e.target.value))}
										className="bg-black/50 border border-white/10 rounded-lg px-3 py-2 text-white"
									>
										{BYTE_UNITS.map((u) => (
											<option key={u.value} value={u.value}>
												{u.label}
											</option>
										))}
									</select>
									<button
										type="button"
										onClick={updateStorageQuota}
										disabled={isQuotaLoading}
										className="bg-hc-red hover:bg-red-600 text-white px-4 py-2 rounded-lg text-sm font-bold"
									>
										{isQuotaLoading ? "Updating..." : "Update"}
									</button>
								</div>
								<p className="text-xs text-text-muted mt-2">
									Current Month Usage:{" "}
									<span className="text-white font-mono">
										{formatBytes(selected.storageUsageBytes)}
									</span>
								</p>
								<div className="w-full bg-white/10 rounded-full h-1.5 mt-2 overflow-hidden">
									<div
										className="bg-hc-red h-1.5 rounded-full"
										style={{ width: `${selectedStoragePercent}%` }}
									/>
								</div>
							</div>

							<div className="bg-black/30 p-6 rounded-xl border border-white/10">
								<h4 className="text-white font-bold mb-4">Egress Limit</h4>
								<div className="flex flex-col gap-3">
									<select
										value={egressMode}
										onChange={(e) =>
											setEgressMode(
												e.target.value as "default" | "unlimited" | "custom",
											)
										}
										className="bg-black/50 border border-white/10 rounded-lg px-3 py-2 text-white"
									>
										<option value="default">
											Default (max(minEgress, storage × multiplier))
										</option>
										<option value="unlimited">Unlimited</option>
										<option value="custom">Custom Amount</option>
									</select>

									{egressMode === "custom" ? (
										<div className="flex gap-2 items-center">
											<input
												type="number"
												step="0.01"
												min={0}
												value={egressAmount}
												onChange={(e) =>
													setEgressAmount(Number(e.target.value))
												}
												className="bg-black/50 border border-white/10 rounded-lg px-3 py-2 text-white w-full"
											/>
											<select
												value={egressUnit}
												onChange={(e) => setEgressUnit(Number(e.target.value))}
												className="bg-black/50 border border-white/10 rounded-lg px-3 py-2 text-white"
											>
												{BYTE_UNITS.map((u) => (
													<option key={u.value} value={u.value}>
														{u.label}
													</option>
												))}
											</select>
										</div>
									) : null}

									<button
										type="button"
										onClick={updateEgressQuota}
										disabled={isQuotaLoading}
										className="bg-hc-red hover:bg-red-600 text-white px-4 py-2 rounded-lg text-sm font-bold w-full"
									>
										{isQuotaLoading ? "Updating..." : "Update Egress Limit"}
									</button>
								</div>
								<p className="text-xs text-text-muted mt-2">
									Current Usage:{" "}
									<span className="text-white font-mono">
										{formatBytes(selected.egressBytes)}
									</span>
								</p>
								{selected.egressLimitBytes && selected.egressLimitBytes > 0 ? (
									<div className="w-full bg-white/10 rounded-full h-1.5 mt-2 overflow-hidden">
										<div
											className="bg-hc-red h-1.5 rounded-full"
											style={{ width: `${selectedEgressPercent}%` }}
										/>
									</div>
								) : null}
							</div>

							<div className="bg-black/30 p-6 rounded-xl border border-white/10">
								<h4 className="text-white font-bold mb-4">Account Status</h4>
								<div className="flex flex-col gap-4">
									<Toggle
										checked={selected.isLocked}
										onChange={toggleLock}
										color="red"
										label="Account Locked"
										disabled={userActionLoading === "lock"}
									/>
									<Toggle
										checked={selected.isImmortal}
										onChange={toggleImmortal}
										color="amber"
										label="Immortal"
										disabled={userActionLoading === "immortal"}
									/>
								</div>
								{selected.isLocked && selected.lockReason ? (
									<div className="mt-2 p-2 bg-red-500/10 border border-red-500/20 rounded text-xs text-red-300">
										<span className="font-bold">Reason:</span>{" "}
										{selected.lockReason}
									</div>
								) : null}
								<p className="text-xs text-text-muted mt-2">
									<strong>Locking:</strong> Denies all access.
									<br />
									<strong>Immortal:</strong> Bypasses quotas, cannot be locked,
									cannot age out.
								</p>
							</div>

							<div className="bg-black/30 p-6 rounded-xl border border-white/10">
								<h4 className="text-white font-bold mb-2">Impersonation</h4>
								<p className="text-xs text-text-muted mb-4">
									Switch your current session into this user. Actions will be
									performed as them.
								</p>
								<button
									type="button"
									onClick={startImpersonation}
									disabled={isImpersonating}
									className="bg-yellow-500/10 hover:bg-yellow-500/20 text-yellow-300 px-4 py-2 rounded-lg text-sm font-bold border border-yellow-500/20 w-full"
								>
									{isImpersonating ? "Switching..." : "Impersonate"}
								</button>
								<p className="text-[11px] text-text-muted mt-3">
									Impersonation lasts 30 minutes. To stop impersonating, log
									out.
								</p>
							</div>

							<div className="bg-red-500/10 p-6 rounded-xl border border-red-500/20">
								<h4 className="text-red-400 font-bold mb-4">Offboarding</h4>
								<button
									type="button"
									disabled={!!selected.markedAsOverAge}
									onClick={markAsOverAge}
									className="bg-red-500/20 hover:bg-red-500/30 disabled:opacity-50 disabled:cursor-not-allowed text-red-300 px-4 py-2 rounded-lg text-sm font-bold border border-red-500/30 w-full text-left flex justify-between items-center"
								>
									<span>
										{isAgeOutLoading
											? "Marking..."
											: selected.markedAsOverAge
												? "User marked as Over-Age"
												: "Mark as Over-Age (Offboarding)"}
									</span>
									{selected.markedAsOverAge ? (
										<span className="text-xs uppercase bg-black/30 px-2 py-0.5 rounded">
											Marked
										</span>
									) : null}
								</button>
								<p className="text-[11px] text-red-300/60 mt-2">Starts offboarding.</p>
							</div>
						</div>

						<h4 className="text-white font-bold mb-2 text-lg">Buckets</h4>
						<div className="bg-black/30 rounded-xl border border-white/10 overflow-hidden">
							<table className="w-full text-left text-sm">
								<thead className="bg-white/5 text-text-muted font-bold uppercase text-xs tracking-wider">
									<tr>
										<th className="px-4 py-3">Name</th>
										<th className="px-4 py-3">Usage</th>
										<th className="px-4 py-3">Status</th>
										<th className="px-4 py-3 text-right">Actions</th>
									</tr>
								</thead>
								<tbody className="divide-y divide-white/5">
									{selectedBuckets.map((b) => (
										<tr key={b.id} className="hover:bg-white/5">
											<td className="px-4 py-3 font-mono text-white">
												{b.name}
											</td>
											<td className="px-4 py-3 font-mono text-xs text-text-muted">
												{formatBytes(b.totalBytes)}
											</td>
											<td className="px-4 py-3">
												{b.isPaused ? (
													<div className="flex flex-col items-start">
														<span className="text-red-400 text-xs font-bold">
															SUSPENDED
														</span>
														{b.pauseReason ? (
															<span
																className="text-[10px] text-red-300 max-w-[180px] truncate"
																title={b.pauseReason}
															>
																{b.pauseReason}
															</span>
														) : null}
													</div>
												) : (
													<span className="text-emerald-400 text-xs font-bold">
														ACTIVE
													</span>
												)}
											</td>
											<td className="px-4 py-3 text-right">
												<button
													type="button"
													onClick={() => openBucketModal(b.name)}
													className="bg-white/5 hover:bg-white/10 border border-white/10 text-white px-3 py-1.5 rounded-lg text-xs font-bold"
												>
													View
												</button>
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					</div>
				) : null}
			</Modal>

			<Modal
				open={!!selectedBucketDetails}
				onClose={closeBucketModal}
				title={selectedBucketDetails?.name || "Bucket Name"}
				className="max-w-4xl p-8"
			>
				{selectedBucketDetails ? (
					<div>
						<p className="text-text-muted text-sm mt-1 font-mono mb-5">
							Owner: {selectedBucketDetails.userId}
						</p>

						<div className="mb-6 flex gap-3 flex-wrap items-center">
							<button
								type="button"
								onClick={() => deleteBucketAdmin(false)}
								disabled={!!bucketActionLoading}
								className="bg-hc-red hover:bg-red-600 text-white px-4 py-2 rounded-lg text-sm font-bold"
							>
								{bucketActionLoading === "bucket-delete"
									? "Deleting..."
									: "Delete Bucket"}
							</button>
							<button
								type="button"
								onClick={() => deleteBucketAdmin(true)}
								disabled={!!bucketActionLoading}
								className="bg-yellow-500/10 hover:bg-yellow-500/20 text-yellow-400 px-4 py-2 rounded-lg text-sm font-bold border border-yellow-500/20"
							>
								{bucketActionLoading === "bucket-empty"
									? "Emptying..."
									: "Empty Bucket"}
							</button>
							<button
								type="button"
								onClick={resetBucketCorsAdmin}
								disabled={!!bucketActionLoading}
								className="bg-white/10 hover:bg-white/20 text-white px-4 py-2 rounded-lg text-sm font-bold border border-white/10"
							>
								{bucketActionLoading === "cors-reset"
									? "Resetting..."
									: "Reset CORS"}
							</button>

							<label className="inline-flex items-center cursor-pointer bg-black/30 px-4 py-2 rounded-lg border border-white/10">
								<input
									type="checkbox"
									className="sr-only peer"
									checked={!!selectedBucketDetails.isPaused}
									disabled={!!bucketActionLoading}
									onChange={(e) => toggleBucketPause(e.target.checked)}
								/>
								<div className="relative w-9 h-5 bg-white/10 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-hc-red rounded-full peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-0.5 after:start-0.5 after:bg-white after:border after:border-gray-300 after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-hc-red" />
								<span className="ms-2 text-xs font-medium text-text-muted peer-checked:text-white">
									{bucketActionLoading === "pause"
										? "Updating..."
										: "Pause Bucket"}
								</span>
							</label>
						</div>
						{selectedBucketDetails.isPaused &&
						selectedBucketDetails.pauseReason ? (
							<div className="mb-6 mt-1 text-xs text-red-300">
								<span className="font-bold">Reason:</span>{" "}
								{selectedBucketDetails.pauseReason}
							</div>
						) : null}

						<h4 className="text-white font-bold mb-4">Keys</h4>
						<div className="bg-black/30 rounded-xl border border-white/10 overflow-hidden mb-6">
							<table className="w-full text-left text-sm">
								<thead className="bg-white/5 text-text-muted font-bold uppercase text-xs tracking-wider">
									<tr>
										<th className="px-4 py-3">Access Key</th>
										<th className="px-4 py-3">Note</th>
										<th className="px-4 py-3">Status</th>
										<th className="px-4 py-3 text-right">Actions</th>
									</tr>
								</thead>
								<tbody className="divide-y divide-white/5">
									{selectedBucketDetails.keys.map((k) => (
										<tr key={k.id} className="hover:bg-white/5">
											<td className="px-4 py-3 font-mono text-white">
												{k.accessKey}
											</td>
											<td className="px-4 py-3 text-xs text-text-muted max-w-[220px]">
												{k.note ? (
													<span
														title={k.note}
														className="line-clamp-2 text-white/80"
													>
														{k.note}
													</span>
												) : (
													<span className="italic">No note</span>
												)}
											</td>
											<td className="px-4 py-3">
												{k.isPaused ? (
													<div className="flex flex-col items-start">
														<span className="text-red-400 text-xs font-bold">
															PAUSED
														</span>
														{k.pauseReason ? (
															<span
																className="text-[10px] text-red-300 max-w-[180px] truncate"
																title={k.pauseReason}
															>
																{k.pauseReason}
															</span>
														) : null}
													</div>
												) : (
													<span className="text-emerald-400 text-xs font-bold">
														ACTIVE
													</span>
												)}
											</td>
											<td className="px-4 py-3 text-right space-x-2">
												<button
													type="button"
													onClick={() => openKeyNoteModal(k)}
													disabled={!!bucketActionLoading}
													className="text-hc-red hover:text-hc-red text-xs font-bold uppercase tracking-wider"
												>
													Note
												</button>
												<button
													type="button"
													onClick={() => toggleKeyPause(k.id, !k.isPaused)}
													disabled={!!bucketActionLoading}
													className={`text-xs font-bold uppercase tracking-wider ${k.isPaused ? "text-emerald-400" : "text-yellow-400"}`}
												>
													{k.isPaused ? "Resume" : "Pause"}
												</button>
												<button
													type="button"
													onClick={() => deleteKeyAdmin(k.id)}
													disabled={!!bucketActionLoading}
													className="text-hc-red hover:text-red-400 text-xs font-bold uppercase tracking-wider"
												>
													Delete
												</button>
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>

						<div className="flex justify-between items-center mb-4">
							<h4 className="text-white font-bold">Files</h4>
							<a
								href={`/dashboard/buckets/${selectedBucketDetails.name}`}
								target="_blank"
								rel="noreferrer"
								className="text-hc-red hover:text-hc-red text-sm font-bold flex items-center gap-1"
							>
								Open File Explorer <MdOpenInNew className="text-base" />
							</a>
						</div>

						<div className="bg-black/30 rounded-xl border border-white/10 overflow-hidden h-64 overflow-y-auto">
							<table className="w-full text-left text-sm">
								<thead className="bg-white/5 text-text-muted font-bold uppercase text-xs tracking-wider sticky top-0">
									<tr>
										<th className="px-4 py-3">Key</th>
										<th className="px-4 py-3">Size</th>
										<th className="px-4 py-3 text-right">Actions</th>
									</tr>
								</thead>
								<tbody className="divide-y divide-white/5">
									{selectedBucketDetails.files.map((f) => (
										<tr key={f.key} className="hover:bg-white/5">
											<td
												className="px-4 py-3 font-mono text-white text-xs truncate max-w-xs"
												title={f.key}
											>
												{f.key}
											</td>
											<td className="px-4 py-3 font-mono text-xs text-text-muted">
												{formatBytes(f.size)}
											</td>
											<td className="px-4 py-3 text-right space-x-2">
												<a
													href={f.url}
													target="_blank"
													rel="noreferrer"
													className="text-hc-red hover:text-hc-red text-xs font-bold uppercase tracking-wider"
												>
													View
												</a>
												<button
													type="button"
													onClick={() => deleteFileAdmin(f.key)}
													disabled={!!bucketActionLoading}
													className="text-hc-red hover:text-red-400 text-xs font-bold uppercase tracking-wider"
												>
													<MdDeleteForever className="inline text-sm" />
												</button>
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					</div>
				) : null}
			</Modal>

			<Modal
				open={!!reasonModal}
				onClose={reasonLoading ? undefined : () => setReasonModal(null)}
				title={reasonModal?.title}
				className="max-w-lg p-8"
			>
				{reasonModal ? (
					<div className="space-y-5">
						<div>
							<label
								htmlFor="admin-reason-modal-input"
								className="text-xs font-bold uppercase tracking-wider text-text-muted"
							>
								{reasonModal.label}
							</label>
							<textarea
								id="admin-reason-modal-input"
								value={reasonValue}
								onChange={(e) => setReasonValue(e.target.value)}
								placeholder={reasonModal.placeholder}
								className="mt-2 w-full min-h-28 bg-black/30 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-hc-red resize-y"
							/>
						</div>
						<div className="flex justify-end gap-3">
							<button
								type="button"
								onClick={() => setReasonModal(null)}
								disabled={reasonLoading}
								className="bg-white/5 hover:bg-white/10 border border-white/10 text-white px-4 py-2.5 rounded-lg text-sm font-bold disabled:opacity-50"
							>
								Cancel
							</button>
							<button
								type="button"
								onClick={async () => {
									setReasonLoading(true);
									try {
										await reasonModal.onSubmit(reasonValue.trim());
										setReasonModal(null);
										setReasonValue("");
									} finally {
										setReasonLoading(false);
									}
								}}
								className="bg-hc-red hover:bg-red-600 text-white px-4 py-2.5 rounded-lg text-sm font-bold disabled:opacity-50"
								disabled={reasonLoading}
							>
								{reasonLoading ? "Saving..." : reasonModal.confirmLabel}
							</button>
						</div>
					</div>
				) : null}
			</Modal>

			<Modal
				open={!!keyNoteModal}
				onClose={keyNoteLoading ? undefined : () => setKeyNoteModal(null)}
				title="Key Note"
				className="max-w-lg p-8"
			>
				{keyNoteModal ? (
					<div className="space-y-5">
						<p className="text-sm text-text-muted font-mono break-all">
							{keyNoteModal.accessKey}
						</p>
						<textarea
							value={keyNoteModal.note}
							onChange={(e) =>
								setKeyNoteModal((prev) =>
									prev ? { ...prev, note: e.target.value } : prev,
								)
							}
							placeholder="Add internal admin note for this key"
							className="w-full min-h-32 bg-black/30 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-hc-red resize-y"
						/>
						<div className="flex justify-end gap-3">
							<button
								type="button"
								onClick={() => setKeyNoteModal(null)}
								disabled={keyNoteLoading}
								className="bg-white/5 hover:bg-white/10 border border-white/10 text-white px-4 py-2.5 rounded-lg text-sm font-bold disabled:opacity-50"
							>
								Cancel
							</button>
							<button
								type="button"
								onClick={saveKeyNote}
								disabled={keyNoteLoading}
								className="bg-hc-red hover:bg-red-600 text-white px-4 py-2.5 rounded-lg text-sm font-bold disabled:opacity-50"
							>
								{keyNoteLoading ? "Saving..." : "Save Note"}
							</button>
						</div>
					</div>
				) : null}
			</Modal>

			<Modal
				open={!!confirmAction}
				onClose={confirmLoading ? undefined : () => setConfirmAction(null)}
				title={confirmAction?.title}
				className="max-w-lg p-8"
			>
				{confirmAction ? (
					<div className="space-y-5">
						<p className="text-sm text-text-muted">{confirmAction.message}</p>
						<div className="flex justify-end gap-3">
							<button
								type="button"
								onClick={() => setConfirmAction(null)}
								disabled={confirmLoading}
								className="bg-white/5 hover:bg-white/10 border border-white/10 text-white px-4 py-2.5 rounded-lg text-sm font-bold disabled:opacity-50"
							>
								Cancel
							</button>
							<button
								type="button"
								onClick={async () => {
									setConfirmLoading(true);
									try {
										await confirmAction.onConfirm();
										setConfirmAction(null);
									} finally {
										setConfirmLoading(false);
									}
								}}
								className={`${confirmAction.confirmClassName || "bg-hc-red hover:bg-red-600 text-white"} px-4 py-2.5 rounded-lg text-sm font-bold disabled:opacity-50`}
								disabled={confirmLoading}
							>
								{confirmLoading ? "Working..." : confirmAction.confirmLabel}
							</button>
						</div>
					</div>
				) : null}
			</Modal>
		</AppShell>
	);
}
