"""Trusted-fixture sparse filesystem, preserving public security guards and paths."""
import pathlib,shutil
# This is qualification infrastructure, not the product tool sandbox or a product installer.
def sparse_command(root,phase,installed,short,inner):
    node=pathlib.Path(shutil.which('node')).resolve()
    args=['bwrap','--die-with-parent','--new-session','--cap-drop','ALL','--cap-add','CAP_NET_RAW','--cap-add','CAP_SETPCAP','--ro-bind','/usr','/usr','--symlink','usr/bin','/bin','--symlink','usr/lib','/lib','--symlink','usr/lib','/lib64','--ro-bind','/etc/ld.so.cache','/etc/ld.so.cache','--proc','/proc','--dev','/dev','--tmpfs','/tmp']
    for source in [node,root/'backend',root/'models',installed]:args += ['--ro-bind',str(source),str(source)]
    for source in [phase,short]:args += ['--bind',str(source),str(source)]
    # No host home/root/runtime-bus/proxy/GPU device or real profile is mounted.
    return [*args,'--chdir',str(installed),*inner]
