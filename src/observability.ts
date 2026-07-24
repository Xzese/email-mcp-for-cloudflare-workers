export function safeErrorCategory(error: unknown): string {
	if (error instanceof DOMException) return error.name || "DOMException";
	if (error instanceof Error) return error.name || "Error";
	return "UnknownError";
}

export async function observeTool<T>(tool: string, operation: () => Promise<T>): Promise<T> {
	const startedAt = Date.now();
	try {
		const result = await operation();
		console.log({
			event: "mcp_tool_call",
			tool,
			status: "success",
			durationMs: Date.now() - startedAt,
		});
		return result;
	} catch (error) {
		console.error({
			event: "mcp_tool_call",
			tool,
			status: "error",
			durationMs: Date.now() - startedAt,
			error: safeErrorCategory(error),
		});
		throw error;
	}
}
