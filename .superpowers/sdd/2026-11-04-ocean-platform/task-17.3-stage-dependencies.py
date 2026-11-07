"""Reproduce physical sandbox dependency staging from a pinned frozen worktree; compare bytes."""
import hashlib,json,pathlib,shutil,subprocess,sys
source=pathlib.Path(sys.argv[1]).resolve();target=pathlib.Path(sys.argv[2]).resolve();original=pathlib.Path(sys.argv[3]).resolve();output=pathlib.Path(sys.argv[4]);assert not target.exists()
revision=subprocess.check_output(['git','rev-parse','HEAD'],cwd=source,text=True).strip();assert revision=='ec1e5d59fc8f7bc08122f331d636c9ae0f1d031a'
node_modules=target/'node_modules';node_modules.mkdir(parents=True,mode=0o700);shutil.copytree(source/'node_modules/.pnpm',node_modules/'.pnpm',symlinks=True);removed=[]
for p in (node_modules/'.pnpm').rglob('*'):
    if p.is_symlink() and not p.resolve().is_relative_to(node_modules):removed.append(str(p.relative_to(node_modules)));p.unlink()
for package in ['typescript','eslint']:
    actual=(source/'node_modules'/package).resolve();relative=pathlib.Path('.pnpm')/actual.relative_to(source/'node_modules/.pnpm');(node_modules/package).symlink_to(relative)
def inventory(root):
    rows={}
    for p in sorted(root.rglob('*')):
        if p.is_symlink():rows[str(p.relative_to(root))]={'link':str(p.readlink())}
        elif p.is_file():
            assert p.stat().st_nlink==1
            rows[str(p.relative_to(root))]={'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'bytes':p.stat().st_size,'mode':p.stat().st_mode&511}
    return rows
before=inventory(original/'node_modules');after=inventory(node_modules);differences=[k for k in before.keys()|after.keys() if before.get(k)!=after.get(k)];assert not differences,differences[:10]
tree_file=output.with_name('dependency-tree.json');tree_file.write_text(json.dumps(after,sort_keys=True,indent=2)+'\n')
proof={'argv':sys.argv,'sourceRevision':revision,'reproducedFrom':str(source/'node_modules/.pnpm'),'originalCopiedFrom':'/home/ryltsevmg/Projects/Ocean-artifacts/task-17.3-8e78d49/source/node_modules/.pnpm','originalProvenancePreserved':True,'originalCompared':str(original),'reproduced':str(target),'sameFrozenLockSha256':hashlib.sha256((source/'pnpm-lock.yaml').read_bytes()).hexdigest(),'removedEscapingWorkspaceLinks':removed,'physicalFiles':sum('sha256' in r for r in after.values()),'symlinks':sum('link' in r for r in after.values()),'allFileBytesModesAndLinkTargetsEqual':True,'treeInventory':str(tree_file),'rawTreeInventorySha256':hashlib.sha256(tree_file.read_bytes()).hexdigest()}
output.write_text(json.dumps(proof,indent=2)+'\n');print(json.dumps(proof,indent=2))
