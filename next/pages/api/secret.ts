import type { NextApiRequest, NextApiResponse } from 'next';
import { Yopass } from '../../src/yopass';
import { v4 as uuidv4 } from 'uuid';

const yopass = Yopass.create();
const validExpirations = [3600];
const MAX_SECRET_LENGTH = process.env.MAX_SECRET_LENGTH ? process.env.MAX_SECRET_LENGTH : 10000
export default async function (req: NextApiRequest, res: NextApiResponse) {
  if (req.headers?.['content-type'] !== 'application/json') {
    res.status(400).json({ message: 'Invalid content type' });
    return;
  }

  const { expiration, secret, one_time } = req.body;

  if (!secret || !one_time || !expiration) {
    res.status(400).json({ message: 'Invalid payload' });
    return;
  }

  if (!validExpirations.includes(expiration)) {
    res.status(400).json({ message: 'Invalid expiration specified' });
    return;
  }

  if (!one_time && process.env.FORCE_ONE_TIME_SECRETS) {
    res.status(400).json({ message: 'Secret must be one time download' });
    return;
  }

  if (secret.length >= MAX_SECRET_LENGTH) {
    res.status(400).json({ message: 'Exceeded max secret length' });
    return;
  }

  try {
    const key = uuidv4();
    await yopass.storeSecret({ secret, ttl: expiration });
    res.status(200).json({ message: key });
  } catch (e) {
    console.log(e)
    res.status(500).json({ message: 'Failed to store secret' });
  }
}
