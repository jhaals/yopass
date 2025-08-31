import { useState } from "react";
import { useForm, type SubmitHandler } from "react-hook-form";
import { randomString } from "@shared/lib/random";
import { encryptMessage } from "@shared/lib/crypto";
import { postSecret } from "@shared/lib/api";
import Result from "@features/display-secret/Result";

export default function CreateSecret() {
  const [secret, setSecret] = useState("");
  const [oneTime, setOneTime] = useState(true);
  const [generateKey, setGenerateKey] = useState(true);
  const [customPassword, setCustomPassword] = useState("");

  const [result, setResult] = useState({
    password: "",
    uuid: "",
    customPassword: false,
  });

  type Secret = {
    secret: string;
    expiration: string;
    oneTime: boolean;
    generateKey: boolean;
    customPassword: string;
  };
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors },
  } = useForm<Secret>();

  const onSubmit: SubmitHandler<Secret> = async (form) => {
    if (!form.secret) {
      return;
    }
    const pw =
      form.customPassword && !generateKey
        ? form.customPassword
        : randomString();
    const { data, status } = await postSecret({
      expiration: parseInt(form.expiration),
      message: await encryptMessage(form.secret, pw),
      one_time: form.oneTime,
    });
    if (status !== 200) {
      setError("secret", { type: "submit", message: data.message });
    } else {
      setResult({
        password: pw,
        uuid: data.message,
        customPassword: !!form.customPassword && !generateKey,
      });
    }
  };

  if (result.uuid) {
    return (
      <Result
        password={result.password}
        uuid={result.uuid}
        prefix="s"
        customPassword={result.customPassword}
        oneTime={oneTime}
      />
    );
  }

  return (
    <>
      <h2 className="text-3xl font-bold mb-4">Encrypt message</h2>
      <form onSubmit={handleSubmit(onSubmit)}>
        {errors.secret && (
          <div className="mb-4 text-red-600 text-sm font-medium">
            {errors.secret.message?.toString()}
          </div>
        )}
        <div className="form-control">
          <label className="label">
            <span className="label-text">Your Secret</span>
          </label>
          <textarea
            {...register("secret")}
            className="textarea textarea-bordered w-full min-h-[100px] text-base p-4 resize-y focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary bg-base-100"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder="Enter your secret..."
            rows={4}
          />
        </div>

        <div className="form-control mt-4">
          <label className="label">
            <span className="label-text font-semibold mb-2">
              The encrypted message will be deleted automatically after
            </span>
          </label>
          <div className="flex flex-row gap-6">
            <label className="cursor-pointer label">
              <input
                type="radio"
                {...register("expiration")}
                className="radio radio-primary mr-2"
                defaultChecked={true}
                value="3600"
              />
              <span className="label-text">One Hour</span>
            </label>
            <label className="cursor-pointer label">
              <input
                type="radio"
                {...register("expiration")}
                className="radio radio-primary mr-2"
                value="86400"
              />
              <span className="label-text">One Day</span>
            </label>
            <label className="cursor-pointer label">
              <input
                type="radio"
                {...register("expiration")}
                className="radio radio-primary mr-2"
                value="604800"
              />
              <span className="label-text">One Week</span>
            </label>
          </div>
          <div className="flex flex-col space-y-4 mt-4">
            <label className="cursor-pointer label">
              <input
                type="checkbox"
                className="checkbox checkbox-primary mr-2"
                {...register("oneTime")}
                checked={oneTime}
                onChange={() => setOneTime(!oneTime)}
              />
              <span className="label-text">One-time download</span>
            </label>
            <label className="cursor-pointer label">
              <input
                type="checkbox"
                className="checkbox checkbox-primary mr-2"
                {...register("generateKey")}
                checked={generateKey}
                onChange={() => setGenerateKey(!generateKey)}
              />
              <span className="label-text">Generate decryption key</span>
            </label>
          </div>
          {!generateKey && (
            <div className="mt-2">
              <label className="label">
                <span className="label-text">Custom Password</span>
              </label>
              <input
                type="password"
                {...register("customPassword")}
                className="input input-bordered w-full"
                value={customPassword}
                onChange={(e) => setCustomPassword(e.target.value)}
                placeholder="Enter your password..."
              />
            </div>
          )}
        </div>

        <div className="form-control mt-6">
          <button className="btn btn-primary w-full max-w-xs" type="submit">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-6 w-6 mr-2"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
              />
            </svg>
            Encrypt Message
          </button>
        </div>
      </form>
    </>
  );
}
