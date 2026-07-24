import assert from "node:assert/strict";
import { buildDraftMessage, decodeHeaderWords, type DraftInput } from "../src/mail/mime.ts";

function draftSource(input: DraftInput): string {
	return new TextDecoder().decode(
		buildDraftMessage("sender@example.com", {
			to: "recipient@example.com",
			subject: "Draft test",
			...input,
		}).source,
	);
}

const plain = draftSource({ text: "Plain draft body" });
assert.match(
	plain,
	/Content-Type: text\/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nPlain draft body/,
);
assert.doesNotMatch(plain, /Content-Transfer-Encoding: base64/);

const titled = draftSource({ subject: "Café update - résumé", text: "Body" });
const subject = titled.match(/^Subject: (.+)$/m)?.[1];
assert.ok(subject);
assert.doesNotMatch(subject, /^=\?UTF-8\?B\?/i);
assert.equal(decodeHeaderWords(subject), "Café update - résumé");

assert.equal(decodeHeaderWords("=?UTF-8?B?Q2Fmw6kgVXBkYXRl?="), "Café Update");
assert.equal(decodeHeaderWords("=?UTF-8?Q?Caf=C3=A9_Update?="), "Café Update");
assert.equal(decodeHeaderWords("=?UTF-8?B?Q2Fmw6k=?= =?UTF-8?B?IFVwZGF0ZQ==?="), "Café Update");

const unicode = draftSource({ text: "cafe = café\ntrailing space \n" });
assert.match(unicode, /cafe =3D caf=C3=A9\r\ntrailing space=20\r\n/);

const alternative = draftSource({
	text: "Plain version",
	html: "<p>HTML = café</p>",
});
assert.match(alternative, /Content-Type: multipart\/alternative; boundary="[^"]+"/);
assert.match(
	alternative,
	/Content-Type: text\/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nPlain version/,
);
assert.match(
	alternative,
	/Content-Type: text\/html; charset="UTF-8"\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n<p>HTML =3D caf=C3=A9<\/p>/,
);
assert.doesNotMatch(alternative, /Content-Transfer-Encoding: base64/);

const withAttachment = draftSource({
	text: "See attached",
	attachments: [
		{
			filename: "hello.txt",
			contentType: "text/plain",
			contentBase64: "SGVsbG8=",
		},
	],
});
assert.match(
	withAttachment,
	/Content-Type: text\/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nSee attached/,
);
assert.match(
	withAttachment,
	/Content-Type: text\/plain\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename="hello\.txt"/,
);

const replyTo = draftSource({
	text: "Reply here",
	replyTo: "Jörg, Support <reply@example.com>",
});
assert.match(replyTo, /^Reply-To: =\?UTF-8\?Q\?J=C3=B6rg,_Support\?= <reply@example\.com>$/m);
