import type { NextApiRequest, NextApiResponse } from 'next';
import { Yopass } from '../../../src/yopass';
import validate from 'uuid-validate';

const yopass = Yopass.create();

export default async function secret(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  const { key } = req.query;

  if (!validate(key, 4)) {
    res.status(400).json({ message: 'Invalid key' });
    return;
  }

  try {
    const result = await (await yopass).getSecret({ key: key as string });
    // TODO: remove snake case one_time
    res.status(200).json({
      message: result.message,
      one_time: result.oneTime,
    });
  } catch (e) {
    res.status(404).json({ message: 'Secret does not exist' });
  }
}
