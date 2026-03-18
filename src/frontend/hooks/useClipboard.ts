import { useCallback, useState } from "react";

export function useClipboard(timeoutMs = 1500) {
	const [copied, setCopied] = useState<string | null>(null);

	const copy = useCallback(
		async (key: string, value: string) => {
			await navigator.clipboard.writeText(value);
			setCopied(key);
			window.setTimeout(
				() => setCopied((prev: string | null) => (prev === key ? null : prev)),
				timeoutMs,
			);
		},
		[timeoutMs],
	);

	return { copied, copy };
}
