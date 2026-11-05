"""Verify full native archive before safe owned extraction and model installation."""
import hashlib,json,pathlib,subprocess,tarfile,posixpath,shutil,sys,struct
P=pathlib.Path(__file__).resolve().parent
Q=pathlib.Path(json.loads((P/'task-17.4-location.json').read_text())['root']); S=Q/'setup'
def sha(path):
    with path.open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
def write(path,value):
    with path.open('x') as f:json.dump(value,f,indent=2);f.write('\n')
archive=S/'ollama-linux-amd64.tar.zst'
assert archive.stat().st_size==1525335029 and sha(archive)=='993e83d08c3d13d17c55009a3e2664c8a25445e644aec3a68bef5abb6abce67d'
entries=[]
zstd=subprocess.Popen(['zstd','-dc',str(archive)],stdout=subprocess.PIPE,close_fds=True)
with tarfile.open(fileobj=zstd.stdout,mode='r|') as tar:
    for entry in tar:
        name=posixpath.normpath(entry.name)
        assert not name.startswith('/') and name!='..' and not name.startswith('../')
        assert entry.isfile() or entry.isdir() or entry.issym() or entry.islnk()
        if entry.issym() or entry.islnk():
            target=posixpath.normpath(posixpath.join(posixpath.dirname(name) if entry.issym() else '',entry.linkname))
            assert not target.startswith('/') and target!='..' and not target.startswith('../')
        entries.append({'name':entry.name,'size':entry.size,'mode':entry.mode,'type':entry.type.decode(),'link':entry.linkname})
assert zstd.wait(timeout=10)==0
write(S/'archive-entries.json',entries)
backend=Q/'backend';backend.mkdir(mode=0o700)
zstd=subprocess.Popen(['zstd','-dc',str(archive)],stdout=subprocess.PIPE,close_fds=True)
with tarfile.open(fileobj=zstd.stdout,mode='r|') as tar:tar.extractall(backend,filter='data')
assert zstd.wait(timeout=10)==0
licenses=[]
for path in backend.rglob('*'):
    if path.is_file() and any(k in path.name.lower() for k in ['license','notice','copying']):
        licenses.append({'path':str(path.relative_to(backend)),'bytes':path.stat().st_size,'sha256':sha(path)})
write(S/'backend-license-inventory.json',licenses)
print(json.dumps({'entries':len(entries),'licenses':licenses},indent=2),flush=True)
manifest=json.loads((S/'qwen3-manifest.json').read_text()); models=Q/'models'; (models/'blobs').mkdir(parents=True)
for entry in [manifest['config'],*manifest['layers']]:
    digest=entry['digest'].removeprefix('sha256:');blob=S/('sha256-'+digest)
    assert blob.stat().st_size==entry['size'] and sha(blob)==digest
    shutil.copyfile(blob,models/'blobs'/blob.name)
target=models/'manifests/registry.ollama.ai/library/qwen3';target.mkdir(parents=True)
shutil.copyfile(S/'qwen3-manifest.json',target/'1.7b')
# Read the actual GGUF metadata and tensor directory; do not infer tensors from marketing tag.
blob=models/'blobs'/('sha256-'+manifest['layers'][0]['digest'][7:]);f=blob.open('rb')
def read(fmt):return struct.unpack('<'+fmt,f.read(struct.calcsize('<'+fmt)))[0]
def string():return f.read(read('Q')).decode('utf8')
def value(kind):
    formats={0:'B',1:'b',2:'H',3:'h',4:'I',5:'i',6:'f',7:'?',10:'Q',11:'q',12:'d'}
    if kind in formats:return read(formats[kind])
    if kind==8:return string()
    if kind==9:
        subtype=read('I');count=read('Q');return [value(subtype) for _ in range(count)]
    raise ValueError('unknown GGUF kind '+str(kind))
assert f.read(4)==b'GGUF';version=read('I');assert version in [2,3]
tensors=read('Q');count=read('Q');metadata={}
for _ in range(count):
    name=string();metadata[name]=value(read('I'))
directory=[]
for _ in range(tensors):
    name=string();dims=read('I');shape=[read('Q') for _ in range(dims)];kind=read('I');offset=read('Q')
    assert name and dims>0 and all(x>0 for x in shape);directory.append({'name':name,'shape':shape,'type':kind,'offset':offset})
assert metadata['general.architecture']=='qwen3' and metadata['qwen3.context_length']>=4096 and tensors>0
parameters=sum(__import__('math').prod(t['shape']) for t in directory)
write(S/'gguf-proof.json',{'version':version,'sha256':sha(blob),'bytes':blob.stat().st_size,'tensorCount':tensors,'parameterCountFromTensorShapes':parameters,'metadata':{k:v for k,v in metadata.items() if not k.startswith('tokenizer.')},'tensors':directory})
print(json.dumps({'ggufVersion':version,'tensorCount':tensors,'parameters':parameters,'context':metadata['qwen3.context_length']}),flush=True)
