import React from "react";

interface ResultProps {
  password: string;
  uuid: string;
  prefix: string;
  customPassword: boolean;
  oneTime: boolean;
}

const Result: React.FC<ResultProps> = ({
  password,
  uuid,
  prefix,
  customPassword,
  oneTime,
}) => {
  const oneClickLink = `${window.location.origin}/#/${prefix}/${uuid}/${password}`;
  const shortLink = `${window.location.origin}/#/${prefix}/${uuid}`;

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
  };

  return (
    <>
      {" "}
      <h2 className="text-3xl font-bold mb-2">Secret stored securely</h2>
      <p className="mb-6 text-base">
        Your secret has been encrypted and stored. Share these links to provide
        access.
      </p>
      {oneTime && (
        <div className="bg-yellow-100 border-l-4 border-yellow-400 text-yellow-800 p-4 rounded mb-6 flex items-start">
          <span className="mr-3 mt-1">
            <svg
              className="w-6 h-6"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M13 16h-1v-4h-1m1-4h.01M12 20a8 8 0 100-16 8 8 0 000 16z"
              />
            </svg>
          </span>
          <div>
            <div className="font-semibold mb-1">Remember</div>
            <div className="text-sm">
              Secrets can only be downloaded once. So do not open the link
              yourself. The cautious should send the decryption key in a
              separate communication channel.
            </div>
          </div>
        </div>
      )}
      {oneClickLink && !customPassword && (
        <div className="mb-4">
          <div className="font-semibold mb-1">One-click link</div>
          <div className="text-sm text-gray-500 mb-2">
            Share this link for direct access to the secret
          </div>
          <div className="flex items-center">
            <button
              className="mr-2 btn btn-outline btn-primary btn-sm"
              onClick={() => copyToClipboard(oneClickLink)}
              title="Copy one-click link"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth="1.5"
                stroke="currentColor"
                className="size-6"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M8.25 7.5V6.108c0-1.135.845-2.098 1.976-2.192.373-.03.748-.057 1.123-.08M15.75 18H18a2.25 2.25 0 0 0 2.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 0 0-1.123-.08M15.75 18.75v-1.875a3.375 3.375 0 0 0-3.375-3.375h-1.5a1.125 1.125 0 0 1-1.125-1.125v-1.5A3.375 3.375 0 0 0 6.375 7.5H5.25m11.9-3.664A2.251 2.251 0 0 0 15 2.25h-1.5a2.251 2.251 0 0 0-2.15 1.586m5.8 0c.065.21.1.433.1.664v.75h-6V4.5c0-.231.035-.454.1-.664M6.75 7.5H4.875c-.621 0-1.125.504-1.125 1.125v12c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V16.5a9 9 0 0 0-9-9Z"
                />
              </svg>
            </button>
            <div className="flex-1 bg-base-200 rounded px-3 py-2">
              <code className="truncate">{oneClickLink}</code>
            </div>
          </div>
        </div>
      )}
      <div className="mb-4">
        <div className="font-semibold mb-1">Short link</div>
        <div className="text-sm text-gray-500 mb-2">
          Requires the decryption key to be shared separately
        </div>
        <div className="flex items-center">
          <button
            className="mr-2 btn btn-outline btn-primary btn-sm"
            onClick={() => copyToClipboard(shortLink)}
            title="Copy short link"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth="1.5"
              stroke="currentColor"
              className="size-6"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M8.25 7.5V6.108c0-1.135.845-2.098 1.976-2.192.373-.03.748-.057 1.123-.08M15.75 18H18a2.25 2.25 0 0 0 2.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 0 0-1.123-.08M15.75 18.75v-1.875a3.375 3.375 0 0 0-3.375-3.375h-1.5a1.125 1.125 0 0 1-1.125-1.125v-1.5A3.375 3.375 0 0 0 6.375 7.5H5.25m11.9-3.664A2.251 2.251 0 0 0 15 2.25h-1.5a2.251 2.251 0 0 0-2.15 1.586m5.8 0c.065.21.1.433.1.664v.75h-6V4.5c0-.231.035-.454.1-.664M6.75 7.5H4.875c-.621 0-1.125.504-1.125 1.125v12c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V16.5a9 9 0 0 0-9-9Z"
              />
            </svg>
          </button>
          <div className="flex-1 bg-base-200 rounded px-3 py-2">
            <code className="truncate">{shortLink}</code>
          </div>
        </div>
      </div>
      <div className="mb-6">
        <div className="font-semibold mb-1">Decryption key</div>
        <div className="text-sm text-gray-500 mb-2">
          Required to decrypt the message with the short link
        </div>
        <div className="flex items-center">
          <button
            className="mr-2 btn btn-outline btn-primary btn-sm"
            onClick={() => copyToClipboard(password)}
            title="Copy decryption key"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth="1.5"
              stroke="currentColor"
              className="size-6"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M8.25 7.5V6.108c0-1.135.845-2.098 1.976-2.192.373-.03.748-.057 1.123-.08M15.75 18H18a2.25 2.25 0 0 0 2.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 0 0-1.123-.08M15.75 18.75v-1.875a3.375 3.375 0 0 0-3.375-3.375h-1.5a1.125 1.125 0 0 1-1.125-1.125v-1.5A3.375 3.375 0 0 0 6.375 7.5H5.25m11.9-3.664A2.251 2.251 0 0 0 15 2.25h-1.5a2.251 2.251 0 0 0-2.15 1.586m5.8 0c.065.21.1.433.1.664v.75h-6V4.5c0-.231.035-.454.1-.664M6.75 7.5H4.875c-.621 0-1.125.504-1.125 1.125v12c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V16.5a9 9 0 0 0-9-9Z"
              />
            </svg>
          </button>
          <div className="flex-1 bg-base-200 rounded px-3 py-2">
            <code className="truncate">{password}</code>
          </div>
        </div>
      </div>
      <div className="flex justify-left">
        <button
          className="btn btn-primary mt-2"
          onClick={() => {
            window.location.href = "/";
          }}
        >
          Create another secret
        </button>
      </div>
    </>
  );
};

export default Result;
