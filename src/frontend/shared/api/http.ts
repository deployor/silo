export async function fetchJson<T>(
	input: RequestInfo | URL,
	init?: RequestInit,
): Promise<T> {
	const res = await fetch(input, init);
	if (!res.ok) {
		const text = await res.text();
		throw new Error(text || `Request failed (${res.status})`);
	}
	return res.json() as Promise<T>;
}

export async function fetchText(
	input: RequestInfo | URL,
	init?: RequestInit,
): Promise<string> {
	const res = await fetch(input, init);
	const text = await res.text();
	if (!res.ok) throw new Error(text || `Request failed (${res.status})`);
	return text;
}
