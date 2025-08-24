import { backendDomain } from "./utils/utils";
import { useParams } from "react-router-dom";
import ErrorPage from "./ErrorPage";
import { useState } from "react";
import { useConfig } from "./utils/ConfigContext";
import { useAsync } from "react-use";
import { Decryptor } from "./Decryptor";

function Prefetcher() {
  const { format, key } = useParams();
  const { PREFETCH_SECRET } = useConfig();
  const [fetchSecret, setFetchSecret] = useState(
    PREFETCH_SECRET ? false : true
  );

  const isFile = format === "f";
  const url = `${backendDomain}/${isFile ? "file" : "secret"}/${key}`;
  const head = useAsync(async () => {
    if (!(PREFETCH_SECRET && !fetchSecret)) {
      return undefined;
    }
    const request = await fetch(url, { method: "HEAD" });
    if (!request.ok || request.status !== 200) {
      throw new Error("Failed to fetch secret");
    }
    return true as const;
  }, [PREFETCH_SECRET, fetchSecret, url]);

  // secret fetcher
  const secret = useAsync(async () => {
    if (!fetchSecret) {
      return undefined;
    }
    const request = await fetch(url);
    if (!request.ok) {
      throw new Error("Failed to fetch secret");
    }
    const json = await request.json();
    if (!json || typeof json.message !== "string") {
      throw new Error("Invalid secret response");
    }
    return json.message as string;
  }, [fetchSecret, url]);

  if (head.loading || secret.loading || (fetchSecret && !secret.value)) {
    return <div>Loading...</div>;
  }
  if (head.error || secret.error) {
    return <ErrorPage />;
  }

  if (!fetchSecret && PREFETCH_SECRET) {
    return (
      <>
        <div className="flex items-center mb-2">
          {/* Unlocked padlock icon */}
          <svg
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth="1.5"
            stroke="currentColor"
            className="h-8 w-8 text-green-500 mr-2"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z"
            />
          </svg>

          <h2 className="text-3xl font-bold">Secure Message</h2>
        </div>
        <p className="mb-6 text-gray-500 text-lg">
          You've received a secure message that can only be viewed once
        </p>
        <div className="bg-base-200 border border-base-300 rounded-xl p-6 mb-8">
          <div className="font-bold text-lg mb-1 text-base-content">
            Important
          </div>
          <div className="text-base-content/80">
            This message may self-destruct after viewing. Once revealed, it may
            not be accessible again.
            <br />
            Make sure you're ready to view it now.
          </div>
        </div>
        <div className="flex justify-center">
          <button
            className="flex items-center gap-2 px-8 py-4 btn btn-primary w-full max-w-xs"
            onClick={() => setFetchSecret(true)}
          >
            {/* Eye icon */}
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
                d="M2.25 12s3.75-6.75 9.75-6.75S21.75 12 21.75 12s-3.75 6.75-9.75 6.75S2.25 12 2.25 12Z"
              />
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"
              />
            </svg>
            Reveal Secure Message
          </button>
        </div>
      </>
    );
  }
  // Actual secret here and render decryptor if password is provided
  if (!secret.value) {
    return <ErrorPage />;
  }
  return <Decryptor secret={secret.value} />;
}

export default Prefetcher;
