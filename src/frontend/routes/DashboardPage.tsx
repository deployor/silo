import { useCallback, useEffect, useMemo, useState } from "react";
import {
	MdAccessTimeFilled,
	MdArrowForward,
	MdCheck,
	MdCheckCircle,
	MdCode,
	MdContentCopy,
	MdDeleteForever,
	MdDeleteOutline,
	MdEdit,
	MdFolderOpen,
	MdGroups,
	MdInfoOutline,
	MdKey,
	MdOutlineRocketLaunch,
	MdPublic,
	MdWarning,
	MdWarningAmber,
} from "react-icons/md";
import { AppShell } from "../components/AppShell";
import { Modal } from "../components/ui/Modal";
import { fetchJson, fetchText } from "../shared/api/http";
import type { AppBootstrap, FrontendUser } from "../shared/types/app";
import { formatBytes } from "../shared/utils/format";

type BucketKey = {
	id: string;
	accessKey: string;
	note?: string | null;
	isPaused?: boolean;
	pauseReason?: string | null;
};
type BucketCreateState = {
	name: string;
	note: string;
	error: string | null;
	loading: boolean;
};
type KeyCreateState = {
	bucketName: string;
	note: string;
	error: string | null;
	loading: boolean;
};
type EditingKeyNoteState = {
	keyId: string;
	value: string;
	saving: boolean;
};
type KeyDeactivateState = {
	bucketName: string;
	key: BucketKey;
	note: string;
	loading: boolean;
	error: string | null;
};
type CredentialModalState = {
	kind: "bucket" | "key";
	bucketName: string;
	accessKey: string;
	secretKey: string;
	publicUrl: string;
};

type DashboardBucket = {
	name: string;
	keys: BucketKey[];
	createdAt: string;
	totalBytes: number;
	totalRequests: number;
	isPublic: boolean;
	isPaused?: boolean;
	pauseReason?: string | null;
	corsConfig?: string | null;
	isCdn?: boolean;
	isCollaborative?: boolean;
	collaborationPermissions?: string[] | null;
	collaborators?: Array<{
		id: string;
		status: string;
		permissions: string[];
		invitedAt?: string;
		acceptedAt?: string | null;
		user: {
			id: string;
			email?: string | null;
			slackId?: string | null;
		};
	}>;
};

type DashboardStats = {
	user: {
		id: string;
		storageUsage: number;
		storageLimit: number;
		egressLimit: number | null;
		ingressBytes: number;
		egressBytes: number;
		totalRequests: number;
		isImmortal?: boolean;
		slackId?: string;
	};
	limits: {
		maxBucketsPerUser: number;
		maxKeysPerBucket: number;
	};
	buckets: DashboardBucket[];
};

type ConfirmDialogState = {
	title: string;
	message: string;
	confirmLabel: string;
	confirmClassName?: string;
	pendingKey?: string;
	publicRiskWarning?: boolean;
	confirmDelaySeconds?: number;
	onConfirm: () => Promise<void>;
};

type CollaborationModalState = {
	bucket: DashboardBucket;
	inviteeUserId: string;
	permissions: {
		manageKeys: boolean;
		manageCors: boolean;
		filesRead: boolean;
		filesWrite: boolean;
	};
	lookup: {
		loading: boolean;
		error: string | null;
		user: {
			id: string;
			email?: string;
			avatarUrl?: string | null;
		} | null;
	};
	saving: boolean;
	error: string | null;
};

export function DashboardPage({ bootstrap }: { bootstrap: AppBootstrap }) {
	const p = bootstrap.props as {
		user?: FrontendUser | null;
		latestSubmission?: { status?: string; projectName?: string } | null;
		yswsQuotaPerHourHuman?: string;
	};

	const [stats, setStats] = useState<DashboardStats | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [activeBucket, setActiveBucket] = useState<DashboardBucket | null>(
		null,
	);
	const [corsBucket, setCorsBucket] = useState<DashboardBucket | null>(null);
	const [corsEditor, setCorsEditor] = useState("[]");
	const [corsError, setCorsError] = useState<string | null>(null);
	const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState | null>(
		null,
	);
	const [confirmLoading, setConfirmLoading] = useState(false);
	const [confirmDelayRemaining, setConfirmDelayRemaining] = useState(0);
	const [publicWarningStep, setPublicWarningStep] = useState(0);
	const [dontShowPublicWarningAgain, setDontShowPublicWarningAgain] =
		useState(false);
	const [credentialModal, setCredentialModal] =
		useState<CredentialModalState | null>(null);
	const [bucketCreateModal, setBucketCreateModal] =
		useState<BucketCreateState | null>(null);
	const [keyCreateModal, setKeyCreateModal] = useState<KeyCreateState | null>(
		null,
	);
	const [editingKeyNote, setEditingKeyNote] =
		useState<EditingKeyNoteState | null>(null);
	const [keyDeactivateModal, setKeyDeactivateModal] =
		useState<KeyDeactivateState | null>(null);
	const [pendingActionKey, setPendingActionKey] = useState<string | null>(null);
	const [collaborationModal, setCollaborationModal] =
		useState<CollaborationModalState | null>(null);

	const buttonBase =
		"inline-flex items-center justify-center gap-2 rounded-xl border text-sm font-bold transition-colors";
	const buttonPrimaryBlue =
		"bg-hc-blue hover:bg-blue-600 border-hc-blue text-white px-6 py-3";
	const buttonPrimaryRed =
		"bg-hc-red hover:bg-red-600 border-hc-red text-white px-6 py-3";
	const buttonNeutral =
		"bg-white/5 hover:bg-white/10 border-white/10 text-white px-4 py-2.5";
	const buttonSubtle =
		"bg-transparent hover:bg-white/5 border-transparent text-text-muted hover:text-white px-4 py-2.5";
	const iconActionBase =
		"peer relative inline-flex items-center justify-center w-8 h-8 rounded-lg transition-colors";
	const iconActionTooltip =
		"pointer-events-none absolute bottom-full right-0 mb-2 whitespace-nowrap rounded-md border border-white/15 bg-black/90 px-2 py-1 text-[10px] font-medium text-white opacity-0 translate-y-1 transition-all peer-hover:opacity-100 peer-hover:translate-y-0 peer-focus-visible:opacity-100 peer-focus-visible:translate-y-0";

	const load = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			setStats(await fetchJson<DashboardStats>("/api/dashboard/stats"));
		} catch (e) {
			setError(e instanceof Error ? e.message : "Failed to load dashboard");
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		load();
	}, [load]);

	const storagePercent = useMemo(() => {
		if (!stats) return 0;
		if (stats.user.isImmortal) return 100;
		const den = stats.user.storageLimit || 1;
		return Math.min(100, (stats.user.storageUsage / den) * 100);
	}, [stats]);

	const sortedBuckets = useMemo(() => {
		if (!stats?.buckets) return [];
		return [...stats.buckets].sort((a, b) =>
			a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
		);
	}, [stats?.buckets]);

	const collaborationPermissionState = (permissions?: string[] | null) => ({
		manageKeys: permissions?.includes("manage_keys") ?? false,
		manageCors: permissions?.includes("manage_cors") ?? false,
		filesRead: permissions?.includes("files_read") ?? false,
		filesWrite: permissions?.includes("files_write") ?? false,
	});

	const egressLimitBytes = useMemo(() => {
		if (!stats) return 0;
		if (stats.user.isImmortal) return Number.POSITIVE_INFINITY;
		if (
			stats.user.egressLimit === null ||
			stats.user.egressLimit === undefined
		) {
			return Math.max(stats.user.storageLimit * 3, 10 * 1024 * 1024 * 1024);
		}
		if (stats.user.egressLimit === -1) return Number.POSITIVE_INFINITY;
		return stats.user.egressLimit;
	}, [stats]);

	const handleCreateBucket = async () => {
		setBucketCreateModal({
			name: "",
			note: "Default key",
			error: null,
			loading: false,
		});
	};

	const submitCreateBucket = async () => {
		if (!bucketCreateModal) return;
		const name = bucketCreateModal.name.trim();
		if (!name) {
			setBucketCreateModal((prev) =>
				prev ? { ...prev, error: "Bucket name is required." } : prev,
			);
			return;
		}
		setBucketCreateModal((prev) =>
			prev ? { ...prev, loading: true, error: null } : prev,
		);
		try {
			const res = await fetchJson<{
				accessKey: string;
				secretKey: string;
				publicUrl: string;
			}>("/api/dashboard/buckets", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name, note: bucketCreateModal.note }),
			});
			setCredentialModal({
				kind: "bucket",
				bucketName: name,
				accessKey: res.accessKey,
				secretKey: res.secretKey,
				publicUrl: res.publicUrl,
			});
			setBucketCreateModal(null);
			await load();
		} catch (e) {
			setBucketCreateModal((prev) =>
				prev
					? {
							...prev,
							loading: false,
							error: e instanceof Error ? e.message : "Failed to create bucket",
						}
					: prev,
			);
		}
	};

	const togglePublic = async (bucketName: string, isPublic: boolean) => {
		const skipPublicWarning =
			typeof window !== "undefined" &&
			window.localStorage.getItem("silo.publicWarning.skip") === "1";
		const showPublicWarningWizard = isPublic && !skipPublicWarning;

		setConfirmDialog({
			title: `Make bucket ${isPublic ? "public" : "private"}`,
			message: isPublic
				? `Anyone with the file URL will be able to access files in ${bucketName}.`
				: `Only authenticated access will be allowed for ${bucketName}.`,
			confirmLabel: isPublic ? "Make Public" : "Make Private",
			confirmClassName: isPublic
				? "bg-hc-red hover:bg-red-600 border-hc-red text-white"
				: "bg-hc-blue hover:bg-blue-600 border-hc-blue text-white",
			pendingKey: `visibility:${bucketName}`,
			publicRiskWarning: showPublicWarningWizard,
			confirmDelaySeconds: isPublic ? 5 : 0,
			onConfirm: async () => {
				await fetchText(`/api/dashboard/buckets/${bucketName}`, {
					method: "PATCH",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ isPublic }),
				});
				await load();
			},
		});
	};

	useEffect(() => {
		if (!confirmDialog) {
			setPublicWarningStep(0);
			setDontShowPublicWarningAgain(false);
			setConfirmDelayRemaining(0);
			return;
		}

		if (confirmDialog.publicRiskWarning) {
			setPublicWarningStep(0);
			setDontShowPublicWarningAgain(false);
			return;
		}

		const initial = confirmDialog.confirmDelaySeconds ?? 0;
		setConfirmDelayRemaining(initial);
		if (initial <= 0) return;

		const timer = window.setInterval(() => {
			setConfirmDelayRemaining((prev) => {
				if (prev <= 1) {
					window.clearInterval(timer);
					return 0;
				}
				return prev - 1;
			});
		}, 1000);

		return () => {
			window.clearInterval(timer);
		};
	}, [confirmDialog]);

	useEffect(() => {
		if (!confirmDialog?.publicRiskWarning) return;
		if (publicWarningStep < 0 || publicWarningStep > 2) return;

		const initial = 5;
		setConfirmDelayRemaining(initial);

		const timer = window.setInterval(() => {
			setConfirmDelayRemaining((prev) => {
				if (prev <= 1) {
					window.clearInterval(timer);
					return 0;
				}
				return prev - 1;
			});
		}, 1000);

		return () => {
			window.clearInterval(timer);
		};
	}, [confirmDialog?.publicRiskWarning, publicWarningStep]);

	const deleteBucket = async (bucketName: string, emptyOnly: boolean) => {
		setConfirmDialog({
			title: emptyOnly ? "Empty bucket" : "Delete bucket",
			message: emptyOnly
				? `This will permanently remove all files in ${bucketName}.`
				: `This will permanently delete ${bucketName} and all of its files.`,
			confirmLabel: emptyOnly ? "Empty Bucket" : "Delete Bucket",
			confirmClassName: "bg-hc-red hover:bg-red-600",
			pendingKey: `bucket:${bucketName}`,
			onConfirm: async () => {
				await fetchText(
					`/api/dashboard/buckets/${bucketName}${emptyOnly ? "?empty=true" : ""}`,
					{ method: "DELETE" },
				);
				await load();
			},
		});
	};

	const generateKey = async (bucketName: string, note?: string) => {
		try {
			const r = await fetchJson<{
				accessKey: string;
				secretKey: string;
				publicUrl: string;
			}>(`/api/dashboard/buckets/${bucketName}/keys`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ note: note || null }),
			});
			setCredentialModal({
				kind: "key",
				bucketName,
				accessKey: r.accessKey,
				secretKey: r.secretKey,
				publicUrl: r.publicUrl,
			});
			await load();
		} catch (e) {
			window.alert(e instanceof Error ? e.message : "Failed to generate key");
		}
	};

	const refreshActiveBucketKeys = useCallback(async (bucketName: string) => {
		const data = await fetchJson<{ keys: BucketKey[] }>(
			`/api/dashboard/buckets/${bucketName}/keys`,
		);
		setActiveBucket((prev) =>
			prev && prev.name === bucketName
				? { ...prev, keys: data.keys || [] }
				: prev,
		);
		setStats((prev) =>
			prev
				? {
						...prev,
						buckets: prev.buckets.map((bucket) =>
							bucket.name === bucketName
								? { ...bucket, keys: data.keys || [] }
								: bucket,
						),
					}
				: prev,
		);
	}, []);

	const copyText = async (value: string) => {
		try {
			await navigator.clipboard.writeText(value);
		} catch {
			window.alert("Failed to copy to clipboard");
		}
	};

	const deleteKey = async (bucketName: string, keyId: string) => {
		setConfirmDialog({
			title: "Delete access key",
			message:
				"Any applications using this key will immediately lose access to this bucket.",
			confirmLabel: "Delete Key",
			confirmClassName: "bg-hc-red hover:bg-red-600",
			pendingKey: `key:${bucketName}:${keyId}`,
			onConfirm: async () => {
				await fetchText(`/api/dashboard/buckets/${bucketName}/keys/${keyId}`, {
					method: "DELETE",
				});
				await refreshActiveBucketKeys(bucketName);
				await load();
			},
		});
	};

	const openGenerateKeyModal = (bucketName: string) => {
		setKeyCreateModal({ bucketName, note: "", error: null, loading: false });
	};

	const submitGenerateKey = async () => {
		if (!keyCreateModal) return;
		setKeyCreateModal((prev) =>
			prev ? { ...prev, loading: true, error: null } : prev,
		);
		try {
			await generateKey(
				keyCreateModal.bucketName,
				keyCreateModal.note.trim() || undefined,
			);
			await refreshActiveBucketKeys(keyCreateModal.bucketName);
			setKeyCreateModal(null);
		} catch (e) {
			setKeyCreateModal((prev) =>
				prev
					? {
							...prev,
							loading: false,
							error: e instanceof Error ? e.message : "Failed to generate key",
						}
					: prev,
			);
		}
	};

	const setKeyPaused = async (
		bucketName: string,
		key: BucketKey,
		pauseReason: string | null,
		isPaused: boolean,
	) => {
		const pendingKey = `dashboard-key-toggle:${bucketName}:${key.id}`;
		setPendingActionKey(pendingKey);
		try {
			await fetchText(`/api/dashboard/buckets/${bucketName}/keys/${key.id}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					isPaused,
					pauseReason,
				}),
			});
			await refreshActiveBucketKeys(bucketName);
		} catch (e) {
			window.alert(
				e instanceof Error ? e.message : "Failed to update key status",
			);
		} finally {
			setPendingActionKey(null);
		}
	};

	const openDeactivateKeyModal = (bucketName: string, key: BucketKey) => {
		setKeyDeactivateModal({
			bucketName,
			key,
			note: key.pauseReason || key.note || "",
			loading: false,
			error: null,
		});
	};

	const submitDeactivateKey = async () => {
		if (!keyDeactivateModal) return;
		setKeyDeactivateModal((prev) =>
			prev ? { ...prev, loading: true, error: null } : prev,
		);
		try {
			await setKeyPaused(
				keyDeactivateModal.bucketName,
				keyDeactivateModal.key,
				keyDeactivateModal.note.trim() || null,
				true,
			);
			setKeyDeactivateModal(null);
		} catch (e) {
			setKeyDeactivateModal((prev) =>
				prev
					? {
							...prev,
							loading: false,
							error:
								e instanceof Error ? e.message : "Failed to deactivate key",
						}
					: prev,
			);
		}
	};

	const startEditingKeyNote = (key: BucketKey) => {
		setEditingKeyNote({
			keyId: key.id,
			value: key.note || "",
			saving: false,
		});
	};

	const saveInlineKeyNote = async (bucketName: string) => {
		if (!editingKeyNote) return;
		setEditingKeyNote((prev) => (prev ? { ...prev, saving: true } : prev));
		try {
			await fetchText(
				`/api/dashboard/buckets/${bucketName}/keys/${editingKeyNote.keyId}`,
				{
					method: "PATCH",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ note: editingKeyNote.value }),
				},
			);
			await refreshActiveBucketKeys(bucketName);
			setEditingKeyNote(null);
		} catch (e) {
			window.alert(e instanceof Error ? e.message : "Failed to save note");
			setEditingKeyNote((prev) => (prev ? { ...prev, saving: false } : prev));
		}
	};

	const openCorsModal = (bucket: DashboardBucket) => {
		setCorsBucket(bucket);
		setCorsError(null);
		if (!bucket.corsConfig) {
			setCorsEditor("[]");
			return;
		}

		try {
			const parsed = JSON.parse(bucket.corsConfig);
			setCorsEditor(JSON.stringify(parsed.CORSRules || parsed, null, 2));
		} catch {
			setCorsEditor(bucket.corsConfig);
		}
	};

	const openCollaborationModal = (bucket: DashboardBucket) => {
		setCollaborationModal({
			bucket,
			inviteeUserId: "",
			permissions: {
				manageKeys: false,
				manageCors: false,
				filesRead: true,
				filesWrite: false,
			},
			lookup: { loading: false, error: null, user: null },
			saving: false,
			error: null,
		});
	};

	const lookupCollaborator = async () => {
		if (!collaborationModal) return;
		const inviteeUserId = collaborationModal.inviteeUserId.trim();
		if (!inviteeUserId) {
			setCollaborationModal((prev) =>
				prev
					? {
							...prev,
							lookup: {
								loading: false,
								error: "User ID is required",
								user: null,
							},
						}
					: prev,
			);
			return;
		}

		setCollaborationModal((prev) =>
			prev
				? {
						...prev,
						lookup: { loading: true, error: null, user: null },
					}
				: prev,
		);

		try {
			const result = await fetchJson<{
				user: { id: string; email?: string; avatarUrl?: string | null };
			}>(
				`/api/dashboard/buckets/${collaborationModal.bucket.name}/collaborators/lookup?userId=${encodeURIComponent(inviteeUserId)}`,
			);
			setCollaborationModal((prev) =>
				prev
					? {
							...prev,
							lookup: { loading: false, error: null, user: result.user },
						}
					: prev,
			);
		} catch (error) {
			setCollaborationModal((prev) =>
				prev
					? {
							...prev,
							lookup: {
								loading: false,
								error: error instanceof Error ? error.message : "Lookup failed",
								user: null,
							},
						}
					: prev,
			);
		}
	};

	const saveCollaborationInvite = async () => {
		if (!collaborationModal) return;
		const permissions = [
			collaborationModal.permissions.manageKeys ? "manage_keys" : null,
			collaborationModal.permissions.manageCors ? "manage_cors" : null,
			collaborationModal.permissions.filesRead ? "files_read" : null,
			collaborationModal.permissions.filesWrite ? "files_write" : null,
		].filter(Boolean);

		setCollaborationModal((prev) =>
			prev ? { ...prev, saving: true, error: null } : prev,
		);

		try {
			await fetchJson(
				`/api/dashboard/buckets/${collaborationModal.bucket.name}/collaborators`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						inviteeUserId: collaborationModal.inviteeUserId.trim(),
						permissions,
					}),
				},
			);
			setCollaborationModal(null);
			await load();
		} catch (error) {
			setCollaborationModal((prev) =>
				prev
					? {
							...prev,
							saving: false,
							error:
								error instanceof Error
									? error.message
									: "Failed to save invite",
						}
					: prev,
			);
		}
	};

	const saveCors = async () => {
		if (!corsBucket) return;
		try {
			const rules = JSON.parse(corsEditor);
			if (!Array.isArray(rules)) {
				setCorsError("Configuration must be a JSON array of CORS rules.");
				return;
			}
			for (const rule of rules) {
				if (!rule?.AllowedOrigins || !rule?.AllowedMethods) {
					setCorsError(
						"Each rule must include AllowedOrigins and AllowedMethods.",
					);
					return;
				}
			}

			setCorsError(null);
			await fetchText(`/api/dashboard/buckets/${corsBucket.name}/cors`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ rules }),
			});
			await load();
			setCorsBucket(null);
		} catch (e) {
			setCorsError(e instanceof Error ? e.message : "Invalid CORS config");
		}
	};

	const resetCors = async () => {
		if (!corsBucket) return;
		try {
			await fetchText(`/api/dashboard/buckets/${corsBucket.name}/cors`, {
				method: "DELETE",
			});
			await load();
			setCorsEditor("[]");
			setCorsError(null);
		} catch (e) {
			setCorsError(e instanceof Error ? e.message : "Failed to reset CORS");
		}
	};

	const runConfirmDialog = async () => {
		if (!confirmDialog) return;
		if (confirmDelayRemaining > 0) return;
		setConfirmLoading(true);
		setPendingActionKey(confirmDialog.pendingKey ?? null);
		try {
			await confirmDialog.onConfirm();
			setConfirmDialog(null);
		} catch (e) {
			window.alert(e instanceof Error ? e.message : "Action failed");
		} finally {
			setConfirmLoading(false);
			setPendingActionKey(null);
		}
	};

	return (
		<AppShell
			title={bootstrap.title}
			user={p.user || null}
			config={bootstrap.config}
		>
			{p.user?.markedAsOverAge ? (
				<div className="bg-hc-dark border border-white/10 rounded-3xl p-6 mb-8 card-shadow flex flex-col md:flex-row items-center justify-between gap-6">
					<div>
						<h3 className="text-white font-bold text-lg">
							Your account is closing soon.
						</h3>
						<p className="text-text-muted text-sm mt-1 max-w-xl">
							Since you're 18, you've aged out of Silo. Existing data will be
							permanently deleted in 2 months.
						</p>
					</div>
					<a
						href="/dashboard/offboarding"
						className="shrink-0 bg-hc-red hover:bg-red-600 text-white px-6 py-3 rounded-xl text-sm font-bold transition-all card-shadow whitespace-nowrap"
					>
						Start Migration <MdArrowForward className="inline text-base" />
					</a>
				</div>
			) : null}

			<div className="mb-10">
				{stats?.user.isImmortal ? null : p.latestSubmission?.status ===
					"pending" ? (
					<div className="bg-hc-dark border border-white/10 rounded-3xl p-8 card-shadow">
						<div className="inline-flex items-center gap-2 bg-yellow-500/10 text-yellow-400 px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wider mb-4 border border-yellow-500/20">
							<MdAccessTimeFilled className="animate-pulse" /> Under Review
						</div>
						<h2 className="text-3xl font-black text-white italic tracking-tight mb-2">
							“{p.latestSubmission.projectName}” is in the pipeline.
						</h2>
						<p className="text-text-muted text-lg max-w-xl">
							We're reviewing your submission. Once approved, your storage quota
							will be upgraded automatically.
						</p>
					</div>
				) : (
					<div className="bg-hc-dark rounded-3xl card-shadow border border-white/10 p-8">
						<h2 className="text-3xl md:text-4xl font-black text-white italic tracking-tight mb-3">
							Ship projects.{" "}
							<span className="text-hc-red">Get paid in storage.</span>
						</h2>
						<p className="text-text-muted text-lg max-w-xl mb-6">
							Built something cool? Submit it to YSWS. Every shipped project
							unlocks{" "}
							<span className="text-white font-bold">
								{p.yswsQuotaPerHourHuman || "more"} of permanent storage
							</span>
							.
						</p>
						<a
							href="/ysws/submit"
							className="bg-hc-red hover:bg-red-500 text-white px-8 py-4 rounded-xl text-lg font-bold transition-all shadow-lg shadow-hc-red/20 inline-flex items-center gap-3"
						>
							<MdOutlineRocketLaunch /> Ship a Project
						</a>
					</div>
				)}
			</div>

			<div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
				<div className="bg-hc-dark rounded-3xl p-6 border border-white/10 card-shadow">
					<h3 className="text-text-muted text-sm font-bold uppercase tracking-wider mb-2">
						Storage Usage
					</h3>
					<div className="flex items-baseline gap-2">
						<span className="text-3xl font-bold text-white">
							{formatBytes(stats?.user.storageUsage || 0)}
						</span>
						<span className="text-text-muted text-sm font-mono">
							/
							{stats?.user.isImmortal
								? "∞"
								: ` ${formatBytes(stats?.user.storageLimit || 0)}`}
						</span>
					</div>
					<div className="w-full bg-white/5 rounded-full h-2 mt-4 overflow-hidden">
						<div
							className={`${stats?.user.isImmortal ? "bg-amber-400" : "bg-hc-red"} h-2 rounded-full transition-all duration-500`}
							style={{ width: `${storagePercent}%` }}
						/>
					</div>
				</div>

				<div className="bg-hc-dark rounded-3xl p-6 border border-white/10 card-shadow">
					<h3 className="text-text-muted text-sm font-bold uppercase tracking-wider mb-2">
						Total Traffic
					</h3>
					<div className="flex justify-between text-sm">
						<span className="text-emerald-400">Ingress (In)</span>
						<span className="text-white">
							{formatBytes(stats?.user.ingressBytes || 0)}
						</span>
					</div>
					<div className="flex justify-between text-sm mt-2">
						<span className="text-hc-red">Egress (Out)</span>
						<span className="text-white">
							{formatBytes(stats?.user.egressBytes || 0)}
						</span>
					</div>
					<div className="text-xs text-text-muted mt-1">
						/
						{egressLimitBytes === Number.POSITIVE_INFINITY
							? " ∞"
							: ` ${formatBytes(egressLimitBytes)}`}
					</div>
				</div>

				<div className="bg-hc-dark rounded-3xl p-6 border border-white/10 card-shadow">
					<h3 className="text-text-muted text-sm font-bold uppercase tracking-wider mb-2">
						API Requests
					</h3>
					<div className="flex items-baseline gap-2">
						<span className="text-3xl font-bold text-white">
							{(stats?.user.totalRequests || 0).toLocaleString()}
						</span>
						<span className="text-text-muted text-sm">requests</span>
					</div>
					<p className="text-xs text-text-muted mt-2">
						Lifetime total across all buckets
					</p>
				</div>
			</div>

			<div className="bg-hc-dark rounded-3xl border border-white/10 overflow-hidden card-shadow">
				<div className="p-6 border-b border-white/10 flex justify-between items-center">
					<div>
						<h2 className="text-xl font-bold text-white">
							Your Storage Inventory
						</h2>
						<p className="text-text-muted text-sm mt-1">
							{stats?.buckets.length || 0} /{" "}
							{stats?.limits.maxBucketsPerUser === -1
								? "∞"
								: stats?.limits.maxBucketsPerUser || 0}{" "}
							buckets utilized
						</p>
					</div>
					<button
						type="button"
						onClick={handleCreateBucket}
						className={`${buttonBase} ${buttonNeutral} px-6 py-3`}
					>
						+ New Bucket
					</button>
				</div>

				{loading ? <p className="px-6 py-4 text-text-muted">Loading…</p> : null}
				{error ? <p className="px-6 py-4 text-red-400">{error}</p> : null}

				<div className="overflow-x-auto">
					<table className="w-full text-left text-sm">
						<thead className="bg-white/5 text-text-muted font-bold uppercase text-xs tracking-wider">
							<tr>
								<th className="px-6 py-4">Name</th>
								<th className="px-6 py-4">Keys</th>
								<th className="px-6 py-4">Usage</th>
								<th className="px-6 py-4">Visibility</th>
								<th className="px-6 py-4">Created</th>
								<th className="px-6 py-4 text-right">Actions</th>
							</tr>
						</thead>
						<tbody className="divide-y divide-white/5">
							{sortedBuckets.map((bucket) =>
								(() => {
									const isCollaborative = !!bucket.isCollaborative;
									const permissions = collaborationPermissionState(
										bucket.collaborationPermissions,
									);
									const canManageKeys =
										!isCollaborative || permissions.manageKeys;
									const canManageCors =
										!isCollaborative || permissions.manageCors;
									const canOpenFiles =
										!isCollaborative || permissions.filesRead;
									const visibilityBusy =
										pendingActionKey === `visibility:${bucket.name}`;
									const bucketBusy =
										pendingActionKey === `bucket:${bucket.name}`;
									return (
										<tr
											key={bucket.name}
											className={`transition-colors group ${isCollaborative ? "bg-yellow-400/[0.04] hover:bg-yellow-400/[0.08]" : "hover:bg-white/5"}`}
										>
											<td className="px-6 py-4 font-medium text-white font-mono">
												{bucket.name}
												{bucket.isCollaborative ? (
													<span className="ml-2 bg-yellow-400/15 text-yellow-200 px-1.5 py-0.5 rounded text-[10px] font-bold border border-yellow-400/30 uppercase tracking-wider">
														Shared
													</span>
												) : null}
												{bucket.isPaused ? (
													<span className="ml-2 bg-red-500/20 text-red-400 px-1.5 py-0.5 rounded text-[10px] font-bold border border-red-500/30">
														PAUSED
													</span>
												) : null}
												{bucket.isCdn ? (
													<span className="ml-2 bg-blue-500/20 text-blue-400 px-1.5 py-0.5 rounded text-[10px] font-bold border border-blue-500/30">
														CDN
													</span>
												) : null}
											</td>
											<td className="px-6 py-4">
												{bucket.isCdn ? (
													<span className="text-text-muted italic">
														Managed
													</span>
												) : !canManageKeys ? (
													<span className="text-text-muted italic">
														No access
													</span>
												) : (
													<button
														type="button"
														onClick={() => setActiveBucket(bucket)}
														className={`${buttonBase} ${buttonNeutral} text-xs px-3 py-1.5 rounded-lg`}
													>
														<MdKey className="text-sm mr-1" />{" "}
														{bucket.keys.length} Keys
													</button>
												)}
											</td>
											<td className="px-6 py-4 text-text-main">
												<div className="text-xs font-mono">
													<div>{formatBytes(bucket.totalBytes)}</div>
													<div className="text-text-muted">
														{bucket.totalRequests.toLocaleString()} reqs
													</div>
												</div>
											</td>
											<td className="px-6 py-4">
												<button
													type="button"
													role="switch"
													aria-checked={bucket.isPublic}
													disabled={
														isCollaborative ||
														!!bucket.isPaused ||
														!!bucket.isCdn ||
														visibilityBusy
													}
													onClick={() =>
														togglePublic(bucket.name, !bucket.isPublic)
													}
													className={`inline-flex items-center gap-2 px-1 py-1 transition-colors ${bucket.isPaused || bucket.isCdn || visibilityBusy ? "opacity-50 cursor-not-allowed" : "hover:opacity-90"}`}
												>
													<span
														className={`relative h-6 w-11 rounded-full border transition-colors ${bucket.isPublic ? "bg-hc-blue/80 border-hc-blue" : "bg-white/10 border-white/20"}`}
													>
														<span
															className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white transition-transform ${bucket.isPublic ? "translate-x-5" : "translate-x-0"}`}
														/>
													</span>
													<span className="text-xs font-semibold text-text-muted min-w-12 text-left">
														{visibilityBusy
															? "Updating..."
															: bucket.isPublic
																? "Public"
																: "Private"}
													</span>
												</button>
											</td>
											<td className="px-6 py-4 text-text-muted text-xs font-mono">
												{new Date(bucket.createdAt).toLocaleDateString()}
											</td>
											<td className="px-6 py-4 text-right flex justify-end items-center gap-1.5">
												{!bucket.isCdn && !isCollaborative && canManageCors ? (
													<button
														type="button"
														onClick={() => openCorsModal(bucket)}
														aria-label="Configure CORS"
														title="Configure CORS"
														className={`${iconActionBase} group text-text-muted hover:text-white hover:bg-white/10`}
													>
														<MdCode className="text-base" />
														<span className={iconActionTooltip}>
															Configure CORS rules
														</span>
													</button>
												) : null}
												{canOpenFiles ? (
													<a
														href={`/dashboard/buckets/${bucket.name}`}
														aria-label="Open bucket files"
														title="Open bucket files"
														className={`${iconActionBase} group text-hc-blue hover:text-blue-300 hover:bg-hc-blue/10`}
													>
														<MdFolderOpen className="text-base" />
														<span className={iconActionTooltip}>
															View bucket files
														</span>
													</a>
												) : null}
												{!bucket.isCdn && !isCollaborative ? (
													<button
														type="button"
														onClick={() => deleteBucket(bucket.name, true)}
														disabled={bucketBusy}
														aria-label="Empty bucket"
														title="Empty bucket"
														className={`${iconActionBase} group text-yellow-300 hover:text-yellow-200 hover:bg-yellow-500/10`}
													>
														<MdDeleteOutline className="text-base" />
														<span className={iconActionTooltip}>
															Delete all files in bucket
														</span>
													</button>
												) : (
													<button
														type="button"
														onClick={() => deleteBucket(bucket.name, true)}
														disabled={bucketBusy}
														aria-label="Empty bucket"
														title="Empty bucket"
														className={`${iconActionBase} group text-hc-red hover:text-red-400 hover:bg-hc-red/10`}
													>
														<MdDeleteOutline className="text-base" />
														<span className={iconActionTooltip}>
															Delete all files in bucket
														</span>
													</button>
												)}
												{!bucket.isCdn && !isCollaborative ? (
													<button
														type="button"
														onClick={() => deleteBucket(bucket.name, false)}
														disabled={bucketBusy}
														aria-label="Delete bucket"
														title="Delete bucket"
														className={`${iconActionBase} group text-hc-red hover:text-red-400 hover:bg-hc-red/10`}
													>
														<MdDeleteForever className="text-base" />
														<span className={iconActionTooltip}>
															Delete bucket and all files
														</span>
													</button>
												) : null}
												{!isCollaborative && !bucket.isCdn ? (
													<button
														type="button"
														onClick={() => openCollaborationModal(bucket)}
														aria-label="Manage collaborators"
														title="Manage collaborators"
														className={`${iconActionBase} group text-yellow-200 hover:text-yellow-100 hover:bg-yellow-400/10`}
													>
														<MdGroups className="text-base" />
														<span className={iconActionTooltip}>
															Manage collaboration
														</span>
													</button>
												) : null}
											</td>
										</tr>
									);
								})(),
							)}
						</tbody>
					</table>
				</div>
			</div>

			<Modal
				open={!!collaborationModal}
				onClose={() => setCollaborationModal(null)}
				title="Bucket Collaboration"
				className="max-w-3xl p-8"
			>
				{collaborationModal ? (
					<div className="space-y-6">
						<div>
							<p className="text-text-muted text-sm font-mono">
								{collaborationModal.bucket.name}
							</p>
							<p className="text-text-muted text-sm mt-2">
								Invite someone by user ID. Shared access is disabled for CDN
								buckets and never includes destructive owner-only actions.
							</p>
						</div>
						<div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_auto]">
							<input
								type="text"
								value={collaborationModal.inviteeUserId}
								onChange={(event) =>
									setCollaborationModal((prev) =>
										prev
											? {
													...prev,
													inviteeUserId: event.target.value,
													lookup: { loading: false, error: null, user: null },
													error: null,
												}
											: prev,
									)
								}
								placeholder="Enter user ID"
								className="w-full bg-black/30 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-yellow-300"
							/>
							<button
								type="button"
								onClick={() => void lookupCollaborator()}
								disabled={collaborationModal.lookup.loading}
								className={`${buttonBase} ${buttonNeutral}`}
							>
								{collaborationModal.lookup.loading
									? "Checking..."
									: "Check user"}
							</button>
						</div>
						{collaborationModal.lookup.error ? (
							<p className="text-sm text-red-400">
								{collaborationModal.lookup.error}
							</p>
						) : null}
						{collaborationModal.lookup.user ? (
							<div className="rounded-2xl border border-yellow-400/20 bg-yellow-400/5 p-4 flex items-center gap-3">
								{collaborationModal.lookup.user.avatarUrl ? (
									<img
										src={collaborationModal.lookup.user.avatarUrl}
										alt={collaborationModal.lookup.user.id}
										className="w-10 h-10 rounded-full"
									/>
								) : null}
								<div>
									<p className="text-white font-bold font-mono">
										{collaborationModal.lookup.user.id}
									</p>
									{collaborationModal.lookup.user.email ? (
										<p className="text-text-muted text-sm">
											{collaborationModal.lookup.user.email}
										</p>
									) : null}
								</div>
							</div>
						) : null}
						<div className="grid sm:grid-cols-2 gap-3">
							{[
								[
									"manageKeys",
									"Manage keys",
									"Create, update, and delete bucket keys",
								],
								[
									"manageCors",
									"Manage CORS",
									"Edit CORS rules for this bucket",
								],
								[
									"filesRead",
									"Access file explorer (read)",
									"Browse, preview, and download files",
								],
								[
									"filesWrite",
									"Access file explorer (write)",
									"Upload, move, rename, and delete files",
								],
							].map(([key, label, hint]) => (
								<label
									key={String(key)}
									className="rounded-2xl border border-white/10 bg-black/20 p-4 flex items-start gap-3"
								>
									<input
										type="checkbox"
										checked={
											collaborationModal.permissions[
												key as keyof CollaborationModalState["permissions"]
											]
										}
										onChange={(event) =>
											setCollaborationModal((prev) => {
												if (!prev) return prev;
												const nextPermissions = {
													...prev.permissions,
													[key]: event.target.checked,
												};
												if (key === "filesWrite" && event.target.checked) {
													nextPermissions.filesRead = true;
												}
												if (key === "filesRead" && !event.target.checked) {
													nextPermissions.filesWrite = false;
												}
												return {
													...prev,
													permissions: nextPermissions,
													error: null,
												};
											})
										}
										className="mt-1"
									/>
									<div>
										<p className="text-white font-bold text-sm">{label}</p>
										<p className="text-text-muted text-xs mt-1">{hint}</p>
									</div>
								</label>
							))}
						</div>
						{collaborationModal.error ? (
							<p className="text-sm text-red-400">{collaborationModal.error}</p>
						) : null}
						<div className="rounded-2xl border border-white/10 bg-black/20 p-4">
							<p className="text-white font-bold text-sm mb-3">
								Current collaborators
							</p>
							<div className="space-y-3 max-h-64 overflow-auto">
								{(collaborationModal.bucket.collaborators || []).length ===
								0 ? (
									<p className="text-text-muted text-sm">
										No invites or collaborators yet.
									</p>
								) : (
									(collaborationModal.bucket.collaborators || []).map(
										(collaborator) => (
											<div
												key={collaborator.id}
												className="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-black/20 px-3 py-3"
											>
												<div>
													<p className="text-white font-mono text-sm">
														{collaborator.user.id}
													</p>
													<p className="text-text-muted text-xs mt-1 uppercase tracking-wider">
														{collaborator.status}
													</p>
												</div>
												<div className="flex flex-wrap justify-end gap-2">
													{collaborator.permissions.map((permission) => (
														<span
															key={permission}
															className="rounded-full border border-white/10 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-text-muted"
														>
															{permission.replace(/_/g, " ")}
														</span>
													))}
												</div>
											</div>
										),
									)
								)}
							</div>
						</div>
						<div className="flex justify-end gap-3">
							<button
								type="button"
								onClick={() => setCollaborationModal(null)}
								className={`${buttonBase} ${buttonSubtle}`}
							>
								Close
							</button>
							<button
								type="button"
								onClick={() => void saveCollaborationInvite()}
								disabled={collaborationModal.saving}
								className={`${buttonBase} ${buttonPrimaryBlue} disabled:opacity-50`}
							>
								{collaborationModal.saving ? "Saving..." : "Send invite"}
							</button>
						</div>
					</div>
				) : null}
			</Modal>

			<Modal
				open={!!bucketCreateModal}
				onClose={() => setBucketCreateModal(null)}
				title={undefined}
				className="max-w-md p-8"
			>
				{bucketCreateModal ? (
					<div className="space-y-5">
						<h3 className="text-2xl font-bold text-white">Create New Bucket</h3>
						<div>
							<label
								htmlFor="create-bucket-name"
								className="block text-sm font-bold text-text-muted mb-2 uppercase tracking-wider"
							>
								Bucket Name
							</label>
							<input
								id="create-bucket-name"
								type="text"
								value={bucketCreateModal.name}
								onChange={(e) =>
									setBucketCreateModal((prev) =>
										prev
											? { ...prev, name: e.target.value, error: null }
											: prev,
									)
								}
								placeholder="my-awesome-project"
								className="w-full bg-black/30 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-hc-red focus:ring-1 focus:ring-hc-red font-mono placeholder-white/20 transition-colors"
							/>
							<p className="text-xs text-text-muted mt-2">
								Only lowercase letters, numbers, and hyphens. Minimum 3
								characters.
							</p>
							<p className="text-xs text-text-muted mt-2">
								Bucket names are global and can&apos;t be changed later.
							</p>
						</div>
						<div>
							<label
								htmlFor="create-bucket-note"
								className="block text-sm font-bold text-text-muted mb-2 uppercase tracking-wider"
							>
								Default Key Note
							</label>
							<textarea
								id="create-bucket-note"
								value={bucketCreateModal.note}
								onChange={(e) =>
									setBucketCreateModal((prev) =>
										prev
											? { ...prev, note: e.target.value, error: null }
											: prev,
									)
								}
								placeholder="Optional note for the first key"
								className="w-full min-h-24 bg-black/30 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-hc-red focus:ring-1 focus:ring-hc-red transition-colors resize-y"
							/>
						</div>
						{bucketCreateModal.error ? (
							<p className="text-sm text-red-400">{bucketCreateModal.error}</p>
						) : null}
						<div className="flex justify-end gap-3">
							<button
								type="button"
								onClick={() => setBucketCreateModal(null)}
								className={`${buttonBase} ${buttonSubtle}`}
							>
								Cancel
							</button>
							<button
								type="button"
								onClick={submitCreateBucket}
								disabled={bucketCreateModal.loading}
								className={`${buttonBase} ${buttonPrimaryBlue} disabled:opacity-50`}
							>
								{bucketCreateModal.loading ? "Creating..." : "Create Bucket"}
							</button>
						</div>
					</div>
				) : null}
			</Modal>

			<Modal
				open={!!activeBucket}
				onClose={() => setActiveBucket(null)}
				title="Manage Keys"
				className="max-w-4xl p-8"
			>
				{activeBucket ? (
					<>
						<p className="text-text-muted text-sm -mt-3 mb-6 font-mono">
							{activeBucket.name}
						</p>
						<div className="bg-black/30 rounded-xl border border-white/10 overflow-hidden mb-6 max-h-[55vh] overflow-y-auto">
							<table className="w-full text-left text-sm">
								<thead className="bg-white/5 text-text-muted font-bold uppercase text-xs tracking-wider sticky top-0">
									<tr>
										<th className="px-4 py-3">Access Key ID</th>
										<th className="px-4 py-3">Note</th>
										<th className="px-4 py-3">Status</th>
										<th className="px-4 py-3 text-right">Actions</th>
									</tr>
								</thead>
								<tbody className="divide-y divide-white/5">
									{activeBucket.keys.length ? (
										activeBucket.keys.map((k) => (
											<tr
												key={k.id}
												className="hover:bg-white/5 transition-colors"
											>
												<td className="px-4 py-3 font-mono text-white">
													{k.accessKey}
												</td>
												<td className="px-4 py-3 text-xs text-text-muted max-w-[260px]">
													{editingKeyNote?.keyId === k.id ? (
														<div className="flex items-center gap-2">
															<input
																type="text"
																value={editingKeyNote.value}
																onChange={(e) =>
																	setEditingKeyNote((prev) =>
																		prev
																			? { ...prev, value: e.target.value }
																			: prev,
																	)
																}
																onKeyDown={(e) => {
																	if (e.key === "Enter") {
																		e.preventDefault();
																		void saveInlineKeyNote(activeBucket.name);
																	}
																	if (e.key === "Escape") {
																		setEditingKeyNote(null);
																	}
																}}
																className="w-full bg-black/30 border border-white/10 rounded-lg px-3 py-1.5 text-white focus:outline-none focus:border-hc-blue"
															/>
															<button
																type="button"
																onClick={() =>
																	void saveInlineKeyNote(activeBucket.name)
																}
																disabled={editingKeyNote.saving}
																className="text-emerald-400 hover:text-emerald-300"
															>
																<MdCheck className="text-base" />
															</button>
														</div>
													) : k.note ? (
														<div className="flex items-center gap-2">
															<span className="text-white/80" title={k.note}>
																{k.note}
															</span>
															<button
																type="button"
																onClick={() => startEditingKeyNote(k)}
																className="text-text-muted hover:text-white"
																title="Edit note"
															>
																<MdEdit className="text-sm" />
															</button>
														</div>
													) : (
														<button
															type="button"
															onClick={() => startEditingKeyNote(k)}
															className="inline-flex items-center gap-2 italic hover:not-italic text-text-muted hover:text-white"
														>
															No note <MdEdit className="text-sm" />
														</button>
													)}
												</td>
												<td className="px-4 py-3">
													{k.isPaused ? (
														<div className="inline-flex items-center gap-2 text-red-300">
															<span
																className="inline-flex h-3 w-3 rounded-full bg-red-400 ring-2 ring-red-400/20 shrink-0"
																title={k.pauseReason || k.note || "Deactivated"}
															/>
															<span className="text-xs font-bold uppercase tracking-wider">
																Off
															</span>
														</div>
													) : (
														<div className="inline-flex items-center gap-2 text-emerald-300">
															<span
																className="inline-flex h-3 w-3 rounded-full bg-emerald-400 ring-2 ring-emerald-400/20 shrink-0"
																title="Active"
															/>
															<span className="text-xs font-bold uppercase tracking-wider">
																On
															</span>
														</div>
													)}
												</td>
												<td className="px-4 py-3 text-right">
													<div className="flex justify-end gap-2">
														<button
															type="button"
															onClick={() =>
																k.isPaused
																	? void setKeyPaused(
																			activeBucket.name,
																			k,
																			null,
																			false,
																		)
																	: openDeactivateKeyModal(activeBucket.name, k)
															}
															disabled={
																pendingActionKey ===
																`dashboard-key-toggle:${activeBucket.name}:${k.id}`
															}
															className={`text-xs font-bold uppercase tracking-wider ${k.isPaused ? "text-emerald-400 hover:text-emerald-300" : "text-yellow-300 hover:text-yellow-200"}`}
														>
															{pendingActionKey ===
															`dashboard-key-toggle:${activeBucket.name}:${k.id}`
																? "..."
																: k.isPaused
																	? "Activate"
																	: "Deactivate"}
														</button>
														<button
															type="button"
															onClick={() => deleteKey(activeBucket.name, k.id)}
															aria-label="Delete key"
															title="Delete key"
															className={`${iconActionBase} group text-hc-red hover:text-red-400 hover:bg-hc-red/10 ml-auto`}
														>
															<MdDeleteForever className="text-base" />
															<span className={iconActionTooltip}>
																Delete this access key
															</span>
														</button>
													</div>
												</td>
											</tr>
										))
									) : (
										<tr>
											<td
												colSpan={4}
												className="px-4 py-8 text-center text-text-muted italic"
											>
												No keys found for this bucket.
											</td>
										</tr>
									)}
								</tbody>
							</table>
						</div>

						<div className="flex items-center justify-between">
							<div className="text-xs text-text-muted font-mono">
								{activeBucket.keys.length} /{" "}
								{stats?.user.isImmortal
									? "∞"
									: stats?.limits.maxKeysPerBucket || 0}{" "}
								keys
							</div>
							<button
								type="button"
								onClick={() => openGenerateKeyModal(activeBucket.name)}
								className={`${buttonBase} ${buttonPrimaryBlue}`}
							>
								+ Generate New Key
							</button>
						</div>
					</>
				) : null}
			</Modal>

			<Modal
				open={!!keyDeactivateModal}
				onClose={() => setKeyDeactivateModal(null)}
				title="Deactivate Key"
				className="max-w-md p-8"
			>
				{keyDeactivateModal ? (
					<div className="space-y-5">
						<p className="text-text-muted text-sm font-mono break-all">
							{keyDeactivateModal.key.accessKey}
						</p>
						<div>
							<label
								htmlFor="deactivate-key-note"
								className="block text-sm font-bold text-text-muted mb-2 uppercase tracking-wider"
							>
								Deactivate Note
							</label>
							<textarea
								id="deactivate-key-note"
								value={keyDeactivateModal.note}
								onChange={(e) =>
									setKeyDeactivateModal((prev) =>
										prev
											? { ...prev, note: e.target.value, error: null }
											: prev,
									)
								}
								placeholder="Optional note shown when hovering the red status dot"
								className="w-full min-h-24 bg-black/30 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-hc-red focus:ring-1 focus:ring-hc-red transition-colors resize-y"
							/>
						</div>
						{keyDeactivateModal.error ? (
							<p className="text-sm text-red-400">{keyDeactivateModal.error}</p>
						) : null}
						<div className="flex justify-end gap-3">
							<button
								type="button"
								onClick={() => setKeyDeactivateModal(null)}
								disabled={keyDeactivateModal.loading}
								className={`${buttonBase} ${buttonSubtle}`}
							>
								Cancel
							</button>
							<button
								type="button"
								onClick={submitDeactivateKey}
								disabled={keyDeactivateModal.loading}
								className={`${buttonBase} ${buttonPrimaryRed} disabled:opacity-50`}
							>
								{keyDeactivateModal.loading
									? "Deactivating..."
									: "Deactivate Key"}
							</button>
						</div>
					</div>
				) : null}
			</Modal>

			<Modal
				open={!!keyCreateModal}
				onClose={() => setKeyCreateModal(null)}
				title={undefined}
				className="max-w-md p-8"
			>
				{keyCreateModal ? (
					<div className="space-y-5">
						<div>
							<h3 className="text-2xl font-bold text-white">
								Generate New Key
							</h3>
							<p className="text-text-muted text-sm mt-1 font-mono">
								{keyCreateModal.bucketName}
							</p>
						</div>
						<div>
							<label
								htmlFor="generate-key-note"
								className="block text-sm font-bold text-text-muted mb-2 uppercase tracking-wider"
							>
								Key Note
							</label>
							<textarea
								id="generate-key-note"
								value={keyCreateModal.note}
								onChange={(e) =>
									setKeyCreateModal((prev) =>
										prev
											? { ...prev, note: e.target.value, error: null }
											: prev,
									)
								}
								placeholder="Optional note for this key"
								className="w-full min-h-24 bg-black/30 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-hc-blue focus:ring-1 focus:ring-hc-blue transition-colors resize-y"
							/>
						</div>
						{keyCreateModal.error ? (
							<p className="text-sm text-red-400">{keyCreateModal.error}</p>
						) : null}
						<div className="flex justify-end gap-3">
							<button
								type="button"
								onClick={() => setKeyCreateModal(null)}
								className={`${buttonBase} ${buttonSubtle}`}
							>
								Cancel
							</button>
							<button
								type="button"
								onClick={submitGenerateKey}
								disabled={keyCreateModal.loading}
								className={`${buttonBase} ${buttonPrimaryBlue} disabled:opacity-50`}
							>
								{keyCreateModal.loading ? "Generating..." : "Generate Key"}
							</button>
						</div>
					</div>
				) : null}
			</Modal>

			<Modal
				open={!!corsBucket}
				onClose={() => setCorsBucket(null)}
				title="CORS Configuration"
				className="max-w-3xl p-8"
			>
				{corsBucket ? (
					<>
						<p className="text-text-muted text-sm -mt-3 mb-6 font-mono">
							{corsBucket.name}
						</p>

						<div className="bg-black/30 rounded-xl border border-white/10 overflow-hidden mb-6">
							<div className="px-4 py-3 border-b border-white/10 bg-white/[0.02]">
								<p className="text-text-muted text-sm flex items-start gap-2">
									<MdInfoOutline className="text-hc-blue text-base mt-0.5" />
									<span>
										Configure CORS as a JSON array of rules. Invalid JSON or
										missing fields will be rejected.
									</span>
								</p>
							</div>
							<textarea
								value={corsEditor}
								onChange={(e) => {
									setCorsEditor(e.target.value);
									setCorsError(null);
								}}
								className="w-full h-64 bg-black/40 p-4 text-white font-mono text-sm focus:outline-none focus:ring-2 focus:ring-hc-blue/40 resize-none"
							/>
						</div>

						{corsError ? (
							<p className="text-xs text-red-400 mb-2 flex items-center gap-2">
								<MdWarning className="text-sm" />
								<span>{corsError}</span>
							</p>
						) : null}
						<div className="flex justify-between items-center mt-6">
							<button
								type="button"
								onClick={resetCors}
								className={`${buttonBase} bg-amber-500/10 hover:bg-amber-500/20 border-amber-500/30 text-amber-300 px-4 py-2.5`}
							>
								Reset CORS
							</button>
							<div className="flex items-center gap-3">
								<button
									type="button"
									onClick={() => setCorsBucket(null)}
									className={`${buttonBase} ${buttonSubtle}`}
								>
									Cancel
								</button>
								<button
									type="button"
									onClick={saveCors}
									className={`${buttonBase} ${buttonPrimaryBlue}`}
								>
									Save Configuration
								</button>
							</div>
						</div>
					</>
				) : null}
			</Modal>

			<Modal
				open={!!credentialModal}
				onClose={() => setCredentialModal(null)}
				title={undefined}
				className="max-w-md p-8"
			>
				{credentialModal ? (
					<>
						<div className="flex items-center gap-3 mb-2">
							<div className="bg-emerald-500/20 p-2 rounded-full text-emerald-400">
								<MdCheckCircle className="text-2xl" />
							</div>
							<h3 className="text-2xl font-bold text-white">
								{credentialModal.kind === "bucket"
									? "Bucket Created!"
									: "Key Generated!"}
							</h3>
						</div>
						<p className="text-text-muted text-sm mb-6 ml-11">
							Save these credentials now. You won&apos;t be able to see the
							Secret Key again.
						</p>

						<div className="space-y-4 bg-black/30 p-6 rounded-xl border border-white/10 mb-8">
							<div>
								<p className="text-xs text-text-muted font-bold uppercase tracking-wider block mb-1">
									Access Key ID
								</p>
								<div className="flex items-center gap-2 bg-black/20 rounded-lg p-2 border border-white/5 hover:border-white/10 transition-colors">
									<div className="font-mono text-sm select-all text-white overflow-x-auto whitespace-nowrap scrollbar-thin flex-1">
										{credentialModal.accessKey}
									</div>
									<button
										type="button"
										onClick={() => copyText(credentialModal.accessKey)}
										className="text-text-muted hover:text-white transition-colors p-1"
										title="Copy"
									>
										<MdContentCopy className="text-lg" />
									</button>
								</div>
							</div>

							<div>
								<p className="text-xs text-text-muted font-bold uppercase tracking-wider block mb-1">
									Secret Access Key
								</p>
								<div className="flex items-center gap-2 bg-black/20 rounded-lg p-2 border border-white/5 hover:border-white/10 transition-colors">
									<div className="font-mono text-sm select-all text-emerald-400 overflow-x-auto whitespace-nowrap scrollbar-thin flex-1">
										{credentialModal.secretKey}
									</div>
									<button
										type="button"
										onClick={() => copyText(credentialModal.secretKey)}
										className="text-text-muted hover:text-white transition-colors p-1"
										title="Copy"
									>
										<MdContentCopy className="text-lg" />
									</button>
								</div>
							</div>

							<div>
								<p className="text-xs text-text-muted font-bold uppercase tracking-wider block mb-1">
									Endpoint
								</p>
								<div className="flex items-center gap-2 bg-black/20 rounded-lg p-2 border border-white/5 hover:border-white/10 transition-colors">
									<div className="font-mono text-sm select-all text-hc-red overflow-x-auto whitespace-nowrap scrollbar-thin flex-1">
										{(() => {
											try {
												return new URL(credentialModal.publicUrl).origin;
											} catch {
												return "https://silo.deployor.dev";
											}
										})()}
									</div>
									<button
										type="button"
										onClick={() =>
											copyText(
												(() => {
													try {
														return new URL(credentialModal.publicUrl).origin;
													} catch {
														return "https://silo.deployor.dev";
													}
												})(),
											)
										}
										className="text-text-muted hover:text-white transition-colors p-1"
										title="Copy"
									>
										<MdContentCopy className="text-lg" />
									</button>
								</div>
							</div>

							<div>
								<p className="text-xs text-text-muted font-bold uppercase tracking-wider block mb-1">
									Public URL Example
								</p>
								<div className="flex items-center gap-2 bg-black/20 rounded-lg p-2 border border-white/5 hover:border-white/10 transition-colors">
									<div className="font-mono text-sm select-all text-hc-blue overflow-x-auto whitespace-nowrap scrollbar-thin flex-1">
										{credentialModal.publicUrl}
									</div>
									<button
										type="button"
										onClick={() => copyText(credentialModal.publicUrl)}
										className="text-text-muted hover:text-white transition-colors p-1"
										title="Copy"
									>
										<MdContentCopy className="text-lg" />
									</button>
								</div>
							</div>
						</div>

						<button
							type="button"
							onClick={() => setCredentialModal(null)}
							className="w-full bg-white/10 hover:bg-white/20 text-white px-4 py-3 rounded-xl text-sm font-bold transition-colors border border-white/5 hover:border-white/20"
						>
							I have saved my keys
						</button>
					</>
				) : null}
			</Modal>

			<Modal
				open={!!confirmDialog}
				onClose={confirmLoading ? undefined : () => setConfirmDialog(null)}
				title={confirmDialog?.title}
				className={`max-w-md p-8 ${confirmDialog?.publicRiskWarning ? "!max-w-2xl bg-[#16090a]" : ""}`}
			>
				{confirmDialog ? (
					<>
						{confirmDialog.publicRiskWarning ? (
							<div className="mt-1 transition-all duration-300 text-white space-y-5">
								<div className="flex items-center justify-center gap-3 pb-1">
									{[
										{
											icon: <MdWarningAmber className="text-2xl" />,
											label: "Use case",
										},
										{
											icon: <MdPublic className="text-2xl" />,
											label: "Exposure",
										},
										{
											icon: <MdGroups className="text-2xl" />,
											label: "Abuse risk",
										},
									].map((step, idx) => {
										const active = publicWarningStep === idx;
										const complete = publicWarningStep > idx;
										return (
											<div
												key={step.label}
												className={`inline-flex h-10 w-10 items-center justify-center rounded-full border transition-colors ${active ? "border-hc-red bg-hc-red/20 text-red-200" : complete ? "border-hc-red/40 bg-hc-red/10 text-red-200" : "border-white/20 bg-white/[0.03] text-white/60"}`}
											>
												{step.icon}
											</div>
										);
									})}
								</div>

								{publicWarningStep === 0 ? (
									<div className="rounded-2xl border border-white/15 bg-white/[0.02] p-5 md:p-6">
										<div className="space-y-4">
											<div>
												<p className="text-xs uppercase tracking-[0.18em] text-hc-red font-black">
													This applies to the ENTIRE bucket
												</p>
												<h4 className="text-2xl font-black text-white leading-tight mt-1">
													Every file in this bucket must be safe to expose.
												</h4>
											</div>
											<div className="grid sm:grid-cols-2 gap-3 text-sm">
												<div className="rounded-xl border border-emerald-400/30 bg-emerald-500/10 p-3">
													<p className="font-black text-emerald-300 uppercase text-[11px] tracking-wider">
														OK TO MAKE PUBLIC
													</p>
													<p className="text-white/90 mt-1">
														Blog images, app icons, CSS/JS bundles, docs
														screenshots.
													</p>
												</div>
												<div className="rounded-xl border border-red-400/25 bg-red-500/[0.06] p-3">
													<p className="font-black text-red-300 uppercase text-[11px] tracking-wider">
														DO NOT MAKE PUBLIC
													</p>
													<p className="text-white/90 mt-1">
														If this bucket contains even one sensitive file,
														keep the entire bucket private.
													</p>
												</div>
											</div>
										</div>
									</div>
								) : null}

								{publicWarningStep === 1 ? (
									<div className="rounded-2xl border border-white/15 bg-white/[0.02] p-5 md:p-6">
										<div className="space-y-4">
											<div>
												<p className="text-xs uppercase tracking-[0.18em] text-hc-red font-black">
													Public means global access
												</p>
												<h4 className="text-2xl font-black text-white leading-tight mt-1">
													Anyone can fetch these URLs.
												</h4>
											</div>
											<div className="grid sm:grid-cols-3 gap-2.5 text-xs sm:text-sm">
												<div className="rounded-xl border border-white/15 bg-white/[0.03] p-3">
													<p className="font-black text-white">People</p>
													<p className="text-white/75 mt-1">
														Anyone with a link.
													</p>
												</div>
												<div className="rounded-xl border border-white/15 bg-white/[0.03] p-3">
													<p className="font-black text-white">Crawlers</p>
													<p className="text-white/75 mt-1">
														Search engines and scanners.
													</p>
												</div>
												<div className="rounded-xl border border-white/15 bg-white/[0.03] p-3">
													<p className="font-black text-white">AI scrapers</p>
													<p className="text-white/75 mt-1">
														Dataset and model collectors.
													</p>
												</div>
											</div>
										</div>
									</div>
								) : null}

								{publicWarningStep === 2 ? (
									<div className="rounded-2xl border border-white/15 bg-white/[0.02] p-5 md:p-6">
										<div className="space-y-4">
											<div>
												<p className="text-xs uppercase tracking-[0.18em] text-hc-red font-black">
													Quota burn + abuse happens fast
												</p>
												<h4 className="text-2xl font-black text-white leading-tight mt-1">
													Traffic spikes can shut this down.
												</h4>
											</div>
											<div className="grid sm:grid-cols-2 gap-3 text-sm">
												<div className="rounded-xl border border-white/15 bg-white/[0.03] p-3">
													<p className="font-black text-hc-red">
														What can happen
													</p>
													<p className="text-white/85 mt-1">
														Bot traffic burns egress + request quota quickly.
													</p>
												</div>
												<div className="rounded-xl border border-white/15 bg-white/[0.03] p-3">
													<p className="font-black text-hc-red">
														What this means
													</p>
													<p className="text-white/85 mt-1">
														Public traffic can burn your quota very quickly,
														even if this bucket only has a few files.
													</p>
												</div>
											</div>
											<label className="flex items-start gap-3 rounded-xl border border-white/15 bg-black/20 p-3 mt-1">
												<input
													type="checkbox"
													checked={dontShowPublicWarningAgain}
													onChange={(e) =>
														setDontShowPublicWarningAgain(e.target.checked)
													}
													className="mt-1 h-4 w-4 rounded border-white/30 bg-black/20 text-hc-red focus:ring-hc-red/40"
												/>
												<span className="text-sm text-white/90 leading-relaxed">
													Don&apos;t show this 3-step warning again on this
													device.
												</span>
											</label>
										</div>
									</div>
								) : null}
							</div>
						) : (
							<p className="text-text-muted text-sm">{confirmDialog.message}</p>
						)}

						<div className="mt-6 flex justify-end gap-3">
							<button
								type="button"
								disabled={confirmLoading}
								onClick={() => setConfirmDialog(null)}
								className={`${buttonBase} ${buttonSubtle} disabled:opacity-50`}
							>
								Cancel
							</button>

							{confirmDialog.publicRiskWarning ? (
								<>
									{publicWarningStep > 0 ? (
										<button
											type="button"
											onClick={() =>
												setPublicWarningStep((s) => Math.max(0, s - 1))
											}
											className={`${buttonBase} ${buttonSubtle}`}
										>
											Back
										</button>
									) : null}

									{publicWarningStep < 2 ? (
										<button
											type="button"
											disabled={confirmDelayRemaining > 0}
											onClick={() =>
												setPublicWarningStep((s) => Math.min(2, s + 1))
											}
											className={`${buttonBase} ${buttonPrimaryRed} disabled:opacity-50`}
										>
											{confirmDelayRemaining > 0
												? `Next (${confirmDelayRemaining}s)`
												: "Next"}
										</button>
									) : (
										<button
											type="button"
											disabled={confirmLoading || confirmDelayRemaining > 0}
											onClick={() => {
												if (
													dontShowPublicWarningAgain &&
													typeof window !== "undefined"
												) {
													window.localStorage.setItem(
														"silo.publicWarning.skip",
														"1",
													);
												}
												runConfirmDialog();
											}}
											className={`${buttonBase} px-6 py-3 ${confirmDialog.confirmClassName || buttonPrimaryRed} disabled:opacity-50`}
										>
											{confirmLoading
												? "Working..."
												: confirmDelayRemaining > 0
													? `${confirmDialog.confirmLabel} (${confirmDelayRemaining}s)`
													: confirmDialog.confirmLabel}
										</button>
									)}
								</>
							) : (
								<button
									type="button"
									disabled={confirmLoading || confirmDelayRemaining > 0}
									onClick={runConfirmDialog}
									className={`${buttonBase} px-6 py-3 ${confirmDialog.confirmClassName || buttonPrimaryRed} disabled:opacity-50`}
								>
									{confirmLoading
										? "Working..."
										: confirmDelayRemaining > 0
											? `${confirmDialog.confirmLabel} (${confirmDelayRemaining}s)`
											: confirmDialog.confirmLabel}
								</button>
							)}
						</div>
					</>
				) : null}
			</Modal>
		</AppShell>
	);
}
