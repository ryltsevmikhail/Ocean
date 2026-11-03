import { CodingArtifactError } from '@runnets/domain';
import { GitCodingProject } from './coding-project.js';
import { codingBaseFiles, codingWorkingTree, codingManifest } from './coding-working-tree.js';
/** Same complete eligible-tree policy/hash as immutable task artifacts; no checkout is performed. */
export async function captureCodingProjectTree(
  root: string,
  expectedBase: string,
): Promise<string> {
  const project = new GitCodingProject();
  const verify = async () => {
    const actual = await project.inspect(root);
    if (actual.root !== root || actual.baseCommit !== expectedBase)
      throw new CodingArtifactError('stale_capture');
  };
  await verify();
  const base = await codingBaseFiles(root, expectedBase);
  const tree = codingManifest(await codingWorkingTree(root, base));
  if (codingManifest(await codingWorkingTree(root, base)) !== tree)
    throw new CodingArtifactError('stale_capture');
  await verify();
  return tree;
}
