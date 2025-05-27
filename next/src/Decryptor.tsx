import { readMessage } from "openpgp";
import { decrypt } from "openpgp";
import { useEffect, useState } from "react";
import QRCode from "react-qr-code";
import { useParams } from "react-router-dom";
import { useAsync } from "react-use";
import { EnterDecryptionKey } from "./EnterDecryptionKey";

export function Decryptor({ secret }: { secret: string }) {
  const { format, password: paramsPassword } = useParams();
  const [password, setPassword] = useState("");
  const tooLongForQRCode = secret.length > 500;
  const [showQR, setShowQR] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // fallback or error handling
    }
  };

  useEffect(() => {
    if (paramsPassword) {
      setPassword(paramsPassword);
    }
  }, [paramsPassword]);

  const { loading, error, value } = useAsync(async () => {
    if (!password) {
      return;
    }
    const message = await decrypt({
      message: await readMessage({ armoredMessage: secret }),
      passwords: password,
      format: format === "f" ? "binary" : "utf8",
    });
    return message.data;
  }, [password, secret, format]);

  if (loading) {
    return <div>Loading...</div>;
  }

  if (error || !value) {
    return (
      <EnterDecryptionKey
        setPassword={setPassword}
        errorMessage={password.length > 0}
      />
    );
  }

  return (
    <>
      <div className="flex items-center mb-2">
        {/* Unlocked padlock icon */}
        <svg
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={1.5}
          stroke="currentColor"
          className="h-8 w-8 text-green-500 mr-2"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M13.5 10.5V6.75a4.5 4.5 0 1 1 9 0v3.75M3.75 21.75h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H3.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z"
          />
        </svg>
        <h2 className="text-3xl font-bold">Decrypted Message</h2>
      </div>
      <p className="mb-6 text-gray-500">
        This secret will not be accessible again. Make sure to save it now!
      </p>
      <div className="mb-6">
        <div className="bg-gray-50 border border-gray-300 rounded-xl p-6 text-xl font-mono whitespace-pre-wrap min-h-[120px]">
          {value}
        </div>
      </div>
      <div className="flex flex-wrap gap-4 mb-2">
        <button
          className="btn btn-primary flex items-center gap-2 min-w-[200px]"
          onClick={handleCopy}
          aria-label="Copy to Clipboard"
        >
          {/* Provided icon with corrected props */}
          <svg
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={1.5}
            stroke="currentColor"
            className="h-6 w-6"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M8.25 7.5V6.108c0-1.135.845-2.098 1.976-2.192.373-.03.748-.057 1.123-.08M15.75 18H18a2.25 2.25 0 0 0 2.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 0 0-1.123-.08M15.75 18.75v-1.875a3.375 3.375 0 0 0-3.375-3.375h-1.5a1.125 1.125 0 0 1-1.125-1.125v-1.5A3.375 3.375 0 0 0 6.375 7.5H5.25m11.9-3.664A2.251 2.251 0 0 0 15 2.25h-1.5a2.251 2.251 0 0 0-2.15 1.586m5.8 0c.065.21.1.433.1.664v.75h-6V4.5c0-.231.035-.454.1-.664M6.75 7.5H4.875c-.621 0-1.125.504-1.125 1.125v12c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V16.5a9 9 0 0 0-9-9Z"
            />
          </svg>
          {copied ? "Copied!" : "Copy to Clipboard"}
        </button>
        <button
          className="btn btn-secondary flex items-center gap-2 min-w-[200px]"
          onClick={() => setShowQR((v) => !v)}
          type="button"
          aria-label="Show QR Code"
        >
          {/* Provided QR code icon with corrected props */}
          <svg
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={1.5}
            stroke="currentColor"
            className="h-6 w-6"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M3.75 4.875c0-.621.504-1.125 1.125-1.125h4.5c.621 0 1.125.504 1.125 1.125v4.5c0 .621-.504 1.125-1.125 1.125h-4.5A1.125 1.125 0 0 1 3.75 9.375v-4.5ZM3.75 14.625c0-.621.504-1.125 1.125-1.125h4.5c.621 0 1.125.504 1.125 1.125v4.5c0 .621-.504 1.125-1.125 1.125h-4.5a1.125 1.125 0 0 1-1.125-1.125v-4.5ZM13.5 4.875c0-.621.504-1.125 1.125-1.125h4.5c.621 0 1.125.504 1.125 1.125v4.5c0 .621-.504 1.125-1.125 1.125h-4.5A1.125 1.125 0 0 1 13.5 9.375v-4.5Z"
            />
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M6.75 6.75h.75v.75h-.75v-.75ZM6.75 16.5h.75v.75h-.75v-.75ZM16.5 6.75h.75v.75h-.75v-.75ZM13.5 13.5h.75v.75h-.75v-.75ZM13.5 19.5h.75v.75h-.75v-.75ZM19.5 13.5h.75v.75h-.75v-.75ZM19.5 19.5h.75v.75h-.75v-.75ZM16.5 16.5h.75v.75h-.75v-.75Z"
            />
          </svg>
          {showQR && !tooLongForQRCode ? "Hide QR Code" : "Show QR Code"}
        </button>
      </div>
      {showQR && !tooLongForQRCode && (
        <div className="mt-6 flex justify-center">
          {/* Placeholder for QR code */}
          <div className="bg-gray-100 border border-gray-300 rounded-xl p-6">
            <QRCode
              //bgColor={palette.background.default}
              //fgColor={palette.text.primary}
              size={150}
              style={{ height: "auto" }}
              value={value}
            />
          </div>
        </div>
      )}
    </>
  );
}
