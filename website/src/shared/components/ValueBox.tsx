// Links and keys stay LTR in every language; only the page around them flips.
export default function ValueBox({ value }: { value: string }) {
  return (
    <div
      dir="ltr"
      className="flex-1 bg-base-100 border border-base-300 rounded-md px-4 py-3 min-h-[2.5rem] min-w-0"
    >
      <code className="text-sm text-base-content/80 font-mono break-words leading-relaxed">
        {value}
      </code>
    </div>
  );
}
