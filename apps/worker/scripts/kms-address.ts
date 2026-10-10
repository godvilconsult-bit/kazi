/**
 * Prints the Ethereum address of AWS KMS signing keys (SIGNER_BACKEND=aws-kms), so they can be
 * given roles at deploy time. Needs AWS credentials + AWS_REGION in the environment.
 *
 *   pnpm -F @kazi/worker kms-address -- <operator key id or ARN> <quoter key id or ARN>
 */
import { awsKmsKey } from "../src/chain/aws-kms";
import { createKmsAccount } from "../src/chain/kms";

const ids = process.argv.slice(2).filter((a) => a !== "--");
if (ids.length === 0) throw new Error("usage: kms-address -- <key id> [<key id> …]");
for (const id of ids) {
  const account = await createKmsAccount(awsKmsKey(id));
  console.log(`${id}: ${account.address}`);
}
