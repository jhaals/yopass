import type { NextApiRequest, NextApiResponse } from 'next';
import { Yopass } from '../../src/yopass';
import { MAX_SECRET_LENGTH, VALID_EXPIRATIONS } from '../../src/api/consts';
const yopass = Yopass.create();

export default async function secret(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  if (req.headers?.['content-type'] !== 'application/json') {
    res.status(400).json({ message: 'Invalid content type' });
    return;
  }

  const { expiration, message, one_time } = req.body;
  if (!message || one_time === undefined || !expiration) {
    res.status(400).json({ message: 'Invalid payload' });
    return;
  }

  if (!VALID_EXPIRATIONS.includes(expiration)) {
    res.status(400).json({ message: 'Invalid expiration specified' });
    return;
  }

  if (!one_time && process.env.FORCE_ONE_TIME_SECRETS) {
    res.status(400).json({ message: 'Secret must be one time download' });
    return;
  }

  if (message.length >= MAX_SECRET_LENGTH) {
    res.status(400).json({ message: 'Exceeded max secret length' });
    return;
  }

  try {
    const { key } = await (
      await yopass
    ).storeSecret({
      secret: message,
      ttl: expiration,
      oneTime: one_time,
    });
    res.status(200).json({ message: key });
  } catch (e) {
    console.log(e);
    res.status(500).json({ message: 'Failed to store secret' });
  }
}
