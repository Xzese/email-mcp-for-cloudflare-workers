export interface AccessEnv {
	ACCESS_LOCAL_DEV: string;
}

export function isLocalDevelopment(request: Request, env: AccessEnv): boolean {
	if (env.ACCESS_LOCAL_DEV !== "true") return false;
	const hostname = new URL(request.url).hostname;
	return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

export async function accessRejection(
	request: Request,
	env: AccessEnv,
	verify: (token: string) => Promise<unknown>,
): Promise<Response | undefined> {
	if (isLocalDevelopment(request, env)) return undefined;

	const token = request.headers.get("Cf-Access-Jwt-Assertion");
	if (!token)
		return new Response("Unauthorized: missing Cloudflare Access assertion", {
			status: 401,
		});

	try {
		await verify(token);
		return undefined;
	} catch {
		return new Response("Forbidden: invalid Cloudflare Access assertion", {
			status: 403,
		});
	}
}
