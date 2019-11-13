import * as React from 'react';

const Error = (
  props: { readonly display: boolean } & React.HTMLAttributes<HTMLElement>,
) =>
  props.display ? (
    <div>
      <h2>Secret does not exist</h2>
      <p className="lead">
        It might be caused by <b>any</b> of these reasons.
      </p>
      <h4>Opened before</h4>A secret can be restricted to a single download. It
      might be lost because the sender clicked this link before you viewed it.
      <p>
        The secret might have been compromised and read by someone else. You
        should contact the sender and request a new secret
      </p>
      <h4>Broken link</h4>
      <p>
        The link must match perfectly in order for the decryption to work, it
        might be missing some magic digits.
      </p>
      <h4>Expired</h4>
      <p>
        No secret last forever. All stored secrets will expires and self
        destruct automatically. Lifetime varies from one hour up to one week.
      </p>
    </div>
  ) : null;

export default Error;
