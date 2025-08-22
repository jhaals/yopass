function ErrorPage() {
  return (
    <>
      <div className="flex items-center mb-2">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={1.5}
          stroke="currentColor"
          className="h-8 w-8 text-error mr-2"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M12 9v3m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
          />
        </svg>
        <h2 className="text-2xl font-bold text-error">Secret does not exist</h2>
      </div>
      <p className="mb-6 text-base">
        It might be caused by any of these reasons:
      </p>
      <div className="mb-6">
        <div className="flex items-center mb-1">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={1.5}
            stroke="currentColor"
            className="h-6 w-6 text-yellow-500 mr-2"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 6v6l4 2"
            />
          </svg>
          <span className="font-bold text-lg">Opened before</span>
        </div>
        <p className="ml-8  mb-4">
          A secret can be restricted to a single download. It might be lost
          because the sender clicked this link before you viewed it.
          <br />
          The secret might have been compromised and read by someone else. You
          should contact the sender and request a new secret.
        </p>
        <hr className="my-2" />
        <div className="flex items-center mb-1 mt-4">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={1.5}
            stroke="currentColor"
            className="h-6 w-6 text-yellow-600 mr-2"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M15.232 5.232l3.536 3.536M9 13.5l-6 6m0 0h6v-6m-6 6l6-6m6-6l6 6"
            />
          </svg>
          <span className="font-bold text-lg">Broken link</span>
        </div>
        <p className="ml-8  mb-4">
          The link must match perfectly in order for the decryption to work, it
          might be missing some magic digits.
        </p>
        <hr className="my-2" />
        <div className="flex items-center mb-1 mt-4">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={1.5}
            stroke="currentColor"
            className="h-6 w-6 text-yellow-500 mr-2"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 6v6l4 2"
            />
          </svg>
          <span className="font-bold text-lg">Expired</span>
        </div>
        <p className="ml-8  mb-4">
          No secret lasts forever. All stored secrets will expire and self
          destruct automatically. Lifetime varies from one hour up to one week.
        </p>
      </div>
    </>
  );
}

export default ErrorPage;
