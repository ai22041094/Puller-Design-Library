import { useRef, useState } from 'react';
import { Box, Check, FileText, Image as ImageIcon, LoaderCircle, RotateCcw, UploadCloud } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { getGetPullerQueryKey, getListPullersQueryKey, useUpdatePullerMedia } from '@workspace/api-client-react';
import type { Puller } from '@workspace/api-client-react';
import { useUpload } from '@workspace/object-storage-web';
import { ModelCanvas } from './three-model-canvas';

const MAX_BYTES = 50 * 1024 * 1024;
type MediaKind = '2d' | '3d';

function privateUrl(path?: string | null) {
  if (!path) return '';
  if (path.startsWith('/objects/')) return `/api/storage${path}`;
  if (path.startsWith('/api/storage/objects/')) return path;
  return '';
}

export function PullerMediaWorkspace({ puller }: { puller: Puller }) {
  const [kind, setKind] = useState<MediaKind>('2d');
  const [localError, setLocalError] = useState('');
  const [notice, setNotice] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();
  const mediaMutation = useUpdatePullerMedia();
  const { uploadFile, isUploading, progress, error: uploadError } = useUpload();
  const currentPath = kind === '2d' ? puller.drawing2dUrl : puller.drawing3dUrl;
  const currentName = kind === '2d' ? puller.drawing2dName : puller.drawing3dName;
  const previewUrl = privateUrl(currentPath);
  const isPdf = kind === '2d' && (currentName || currentPath || '').toLowerCase().endsWith('.pdf');
  const isImage = kind === '2d' && !!previewUrl && !isPdf;
  const modelUnsupported = kind === '3d' && !!currentPath && !previewUrl;

  const onPick = async (file?: File) => {
    setLocalError('');
    setNotice('');
    if (!file) return;
    const ext = file.name.split('.').pop()?.toLowerCase();
    const allowed = kind === '2d' ? ['png', 'jpg', 'jpeg', 'webp', 'pdf'] : ['glb', 'stl'];
    if (!ext || !allowed.includes(ext)) {
      setLocalError(`Unsupported ${kind === '2d' ? '2D drawing' : '3D model'} format. Choose ${allowed.join(', ').toUpperCase()}.`);
      return;
    }
    if (file.size > MAX_BYTES) {
      setLocalError('This file is larger than 50 MB. Choose a smaller file.');
      return;
    }
    const result = await uploadFile(file);
    if (!result) {
      setLocalError('Upload did not complete. Try again.');
      return;
    }
    const media = kind === '2d'
      ? { drawing2dUrl: result.objectPath, drawing2dName: file.name }
      : { drawing3dUrl: result.objectPath, drawing3dName: file.name };
    mediaMutation.mutate({ pullerId: puller.id, data: media }, {
      onSuccess: async () => {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: getGetPullerQueryKey(puller.id) }),
          queryClient.invalidateQueries({ queryKey: getListPullersQueryKey() }),
        ]);
        setNotice(`${kind === '2d' ? '2D drawing' : '3D model'} saved.`);
      },
      onError: () => setLocalError('The upload finished, but the puller record could not be updated. Try again.'),
    });
  };

  const accept = kind === '2d' ? '.png,.jpg,.jpeg,.webp,.pdf' : '.glb,.stl';
  return <section className="panel media-workspace" aria-labelledby="media-title">
    <div className="panel-head">
      <div><h2 id="media-title" className="panel-title">Technical media</h2><div className="panel-caption">Private drawings and inspectable 3D geometry</div></div>
      <span className="private-pill">Private files</span>
    </div>
    <div className="media-tabs" role="tablist" aria-label="Technical media type">
      <button className={`media-tab ${kind === '2d' ? 'active' : ''}`} role="tab" aria-selected={kind === '2d'} onClick={() => { setKind('2d'); setLocalError(''); }}>
        <ImageIcon size={15} /> 2D drawing
      </button>
      <button className={`media-tab ${kind === '3d' ? 'active' : ''}`} role="tab" aria-selected={kind === '3d'} onClick={() => { setKind('3d'); setLocalError(''); }}>
        <Box size={15} /> 3D model
      </button>
    </div>
    <div className="media-stage" role="tabpanel">
      {kind === '2d' && isImage && <img className="drawing-preview" src={previewUrl} alt={`${currentName || puller.partName} technical drawing`} />}
      {kind === '2d' && isPdf && <iframe className="drawing-pdf" title={`${currentName || puller.partName} PDF drawing`} src={previewUrl} />}
      {kind === '3d' && previewUrl && <ModelCanvas src={previewUrl} filename={currentName || ''} />}
      {kind === '3d' && modelUnsupported && <div className="media-empty"><Box size={27}/><strong>Model preview unavailable</strong><span>This saved reference is not a private object path. Replace it with a GLB or STL file to inspect it here.</span></div>}
      {!currentPath && <div className="media-empty"><div className="media-empty-icon">{kind === '2d' ? <FileText size={23}/> : <Box size={23}/>}</div><strong>No {kind === '2d' ? '2D drawing' : '3D model'} attached</strong><span>{kind === '2d' ? 'Add a dimensioned image or PDF drawing for this design.' : 'Upload a GLB or STL to inspect geometry in the model viewer.'}</span></div>}
    </div>
    <div className="media-controls">
      <div className="media-file-meta">
        <span className="spec-label">{currentPath ? 'Current file' : 'Accepted formats'}</span>
        <strong>{currentPath ? currentName || 'Attached technical file' : kind === '2d' ? 'PNG · JPG · WebP · PDF' : 'GLB · STL'}</strong>
        <small>{currentPath ? 'Served through an authenticated same-origin route' : 'Maximum file size 50 MB'}</small>
      </div>
      <div className="media-actions">
        <input ref={inputRef} className="sr-only" type="file" accept={accept} aria-label={`Choose ${kind === '2d' ? '2D drawing' : '3D model'} file`} disabled={isUploading || mediaMutation.isPending} onChange={e => { void onPick(e.currentTarget.files?.[0]); e.currentTarget.value = ''; }} />
        <button className="btn primary" onClick={() => inputRef.current?.click()} disabled={isUploading || mediaMutation.isPending}>
          {isUploading ? <LoaderCircle className="spin" size={15}/> : currentPath ? <RotateCcw size={15}/> : <UploadCloud size={15}/>}
          {isUploading ? 'Uploading…' : currentPath ? 'Replace file' : 'Upload file'}
        </button>
      </div>
    </div>
    {isUploading && <div className="upload-progress" aria-live="polite"><div className="upload-progress-top"><span>Uploading {kind === '2d' ? 'drawing' : 'model'}</span><span>{progress}%</span></div><div className="bar-track"><div className="bar-fill" style={{ width: `${progress}%` }} /></div></div>}
    {mediaMutation.isPending && <p className="media-status" role="status"><LoaderCircle size={14} className="spin"/> Saving file reference…</p>}
    {(localError || uploadError) && <p className="media-error" role="alert">{localError || uploadError?.message}</p>}
    {notice && !mediaMutation.isPending && <p className="media-success" role="status"><Check size={14}/>{notice}</p>}
  </section>;
}
