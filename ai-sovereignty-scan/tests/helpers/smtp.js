// Local SMTP capture server (Mailpit-style) for end-to-end tests.
import { SMTPServer } from "smtp-server";
import { simpleParser } from "mailparser";

export async function startSmtpCapture() {
  const messages = [];
  const server = new SMTPServer({
    authOptional: true,
    disabledCommands: ["STARTTLS"],
    logger: false,
    onAuth(auth, _session, cb) {
      cb(null, { user: auth.username });
    },
    onData(stream, session, cb) {
      simpleParser(stream)
        .then((mail) => {
          messages.push({ mail, envelope: session.envelope });
          cb();
        })
        .catch(cb);
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.server.address().port;
  return {
    port,
    messages,
    cfg: { host: "127.0.0.1", port, user: "test", pass: "test", from: "Scan <scan@test.local>", to: "info@oneviewlogic.com", copyToClient: true },
    close: () => new Promise((r) => server.close(r)),
  };
}
