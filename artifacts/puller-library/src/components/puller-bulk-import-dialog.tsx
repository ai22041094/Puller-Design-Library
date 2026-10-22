import { useEffect, useMemo, useRef, useState } from 'react';
import { Download, FileUp, LoaderCircle, UploadCloud, X } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import {
  getGetDashboardQueryKey,
  getGetPullerQueryKey,
  getListPullersQueryKey,
  listPullers,
  useBulkImportPullers,
} from '@workspace/api-client-react';
import type { Puller, PullerBulkImportItem, PullerSpecificationImport } from '@workspace/api-client-react';
import { useUpload } from '@workspace/object-storage-web';
import { Unzip, UnzipInflate, UnzipPassThrough } from 'fflate';

const MAX_CSV_BYTES = 2 * 1024 * 1024;
const MAX_CORRECTION_CSV_BYTES = 4 * 1024 * 1024;
const MAX_ZIP_BYTES = 100 * 1024 * 1024;
const MAX_MEDIA_BYTES = 50 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 500 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 1_000;

const textFields = [
  'waveCode', 'developmentNumber', 'mouldOrderNumber', 'size', 'compatibilityType',
  'material', 'assemblyType', 'logoMark', 'color', 'finish', 'specialProcess',
  'torqueCpsc', 'pcsPerShot', 'inHouseOutsource', 'capacity', 'cost',
  'needleDetector', 'buyerName', 'depotCode', 'requestedBy', 'marketType',
  'requirementName', 'requirementNumber', 'remarks',
] as const;
const numberFields = [
  'overallLength', 'overallWidth', 'overallHeight', 'thickness',
  'holeDiameter', 'holeSpacing', 'weight',
] as const;
const fieldNames = new Set<string>([
  ...textFields, ...numberFields, 'dimensionUnit',
]);
const csvHeaders = ['uniqueIdentifier', ...textFields, 'dimensionUnit', ...numberFields];
const headerAliases = new Map<string, string>(
  csvHeaders.map((name) => [normalizeHeader(name), name]),
);
headerAliases.set('identifier', 'uniqueIdentifier');
headerAliases.set('pulleridentifier', 'uniqueIdentifier');

type CsvRecord = {
  line: number;
  uniqueIdentifier: string;
  specifications: PullerSpecificationImport;
  sourceHeaders: string[];
  sourceValues: string[];
  errors: string[];
};
type ImportPreviewRow = {
  record: CsvRecord;
  puller?: Puller;
  media: { drawing2d?: File; drawing3d?: File };
  errors: string[];
};

function normalizeHeader(value: string) {
  return value.trim().replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (quoted) {
        quoted = false;
      } else if (field.length === 0) {
        quoted = true;
      } else {
        throw new Error('A quote appears in an unquoted CSV value.');
      }
    } else if (char === ',' && !quoted) {
      row.push(field);
      field = '';
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }
  if (quoted) throw new Error('The CSV ends inside a quoted value.');
  row.push(field);
  if (row.some((value) => value.trim())) rows.push(row);
  return rows;
}

function readCsv(text: string) {
  const errors: string[] = [];
  const rows = parseCsv(text.replace(/^\uFEFF/, ''));
  if (rows.length < 2) {
    return { records: [] as CsvRecord[], errors: ['The CSV must include a header row and at least one puller row.'] };
  }

  const mappedHeaders = rows[0].map((header) => {
    const normalized = normalizeHeader(header);
    return normalized === 'validationerrors' ? 'validationErrors' : headerAliases.get(normalized);
  });
  if (!mappedHeaders.includes('uniqueIdentifier')) {
    errors.push('The CSV needs a uniqueIdentifier column (identifier is also accepted).');
  }
  const seenHeaders = new Set<string>();
  mappedHeaders.forEach((header, index) => {
    if (!header) errors.push(`Unknown column "${rows[0][index]}". Use the provided CSV template headers.`);
    else if (seenHeaders.has(header)) errors.push(`The "${header}" column appears more than once.`);
    else seenHeaders.add(header);
  });
  if (errors.length) return { records: [] as CsvRecord[], errors };

  const records: CsvRecord[] = [];
  const seenIdentifiers = new Set<string>();
  rows.slice(1).forEach((values, index) => {
    const line = index + 2;
    const rowErrors: string[] = [];
    const sourceValues = [...values];
    if (values.length !== mappedHeaders.length) {
      rowErrors.push(`CSV row ${line} has ${values.length} values; expected ${mappedHeaders.length}.`);
    }
    const rowValues = new Map(mappedHeaders.map((header, column) => [header!, values[column]?.trim() ?? '']));
    const uniqueIdentifier = rowValues.get('uniqueIdentifier') ?? '';
    if (!uniqueIdentifier) {
      rowErrors.push(`CSV row ${line} is missing its puller identifier.`);
    }
    const identifierKey = uniqueIdentifier.toLocaleLowerCase();
    if (uniqueIdentifier && seenIdentifiers.has(identifierKey)) {
      rowErrors.push(`CSV row ${line} repeats puller identifier "${uniqueIdentifier}".`);
    } else if (uniqueIdentifier) {
      seenIdentifiers.add(identifierKey);
    }

    const specifications: PullerSpecificationImport = {};
    for (const [header, rawValue] of rowValues) {
      if (header === 'uniqueIdentifier' || header === 'validationErrors' || !rawValue) continue;
      if (numberFields.includes(header as typeof numberFields[number])) {
        const number = Number(rawValue);
        if (!Number.isFinite(number) || number < 0) {
          rowErrors.push(`CSV row ${line}: ${header} must be a non-negative number.`);
          continue;
        }
        (specifications as Record<string, unknown>)[header] = number;
      } else if (header === 'dimensionUnit') {
        if (!['mm', 'cm', 'in'].includes(rawValue)) {
          rowErrors.push(`CSV row ${line}: dimensionUnit must be mm, cm, or in.`);
          continue;
        }
        specifications.dimensionUnit = rawValue as PullerSpecificationImport['dimensionUnit'];
      } else if (textFields.includes(header as typeof textFields[number])) {
        (specifications as Record<string, unknown>)[header] = rawValue;
      } else if (!fieldNames.has(header)) {
        rowErrors.push(`CSV row ${line}: unsupported configuration "${header}".`);
      }
    }
    records.push({ line, uniqueIdentifier, specifications, sourceHeaders: [...rows[0]], sourceValues, errors: rowErrors });
  });
  if (records.length > 500) errors.push('The CSV can contain at most 500 pullers per import.');
  return { records, errors };
}

function mediaType(name: string) {
  const ext = name.split('.').pop()?.toLowerCase();
  if (['png', 'jpg', 'jpeg', 'webp', 'pdf'].includes(ext ?? '')) return 'drawing2d' as const;
  if (['glb', 'stl'].includes(ext ?? '')) return 'drawing3d' as const;
  return undefined;
}

function mimeType(name: string) {
  const ext = name.split('.').pop()?.toLowerCase();
  const types: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
    pdf: 'application/pdf', glb: 'model/gltf-binary', stl: 'model/stl',
  };
  return types[ext ?? ''] ?? 'application/octet-stream';
}

async function extractZip(archive: File) {
  if (archive.size > MAX_ZIP_BYTES) {
    throw new Error('The ZIP must be 100 MB or smaller.');
  }
  const files: File[] = [];
  const errors: string[] = [];
  let entryCount = 0;
  let expandedBytes = 0;
  const unzip = new Unzip((entry) => {
    entryCount += 1;
    if (entryCount > MAX_ZIP_ENTRIES) {
      if (entryCount === MAX_ZIP_ENTRIES + 1) errors.push('The ZIP contains more than 1,000 entries.');
      return;
    }
    if (entry.name.endsWith('/') || entry.name.startsWith('__MACOSX/') || entry.name.split('/').pop()?.startsWith('.')) return;
    const kind = mediaType(entry.name);
    if (!kind) {
      errors.push(`Unsupported ZIP entry "${entry.name}". Only 2D drawings and GLB/STL models are accepted.`);
      return;
    }
    if (typeof entry.originalSize !== 'number' || entry.originalSize > MAX_MEDIA_BYTES) {
      errors.push(`ZIP entry "${entry.name}" is larger than 50 MB or its size could not be verified.`);
      return;
    }
    expandedBytes += entry.originalSize;
    if (expandedBytes > MAX_EXPANDED_BYTES) {
      if (expandedBytes - entry.originalSize <= MAX_EXPANDED_BYTES) errors.push('The ZIP expands to more than 500 MB of supported files.');
      return;
    }

    const chunks: ArrayBuffer[] = [];
    let entrySize = 0;
    let failed = false;
    entry.ondata = (error, data, final) => {
      if (error) {
        failed = true;
        errors.push(`Could not read ZIP entry "${entry.name}".`);
        return;
      }
      if (data) {
        entrySize += data.length;
        if (entrySize > MAX_MEDIA_BYTES) {
          failed = true;
          errors.push(`ZIP entry "${entry.name}" expands past the 50 MB file limit.`);
          void entry.terminate();
          return;
        }
        const stableChunk = new ArrayBuffer(data.length);
        new Uint8Array(stableChunk).set(data);
        chunks.push(stableChunk);
      }
      if (final && !failed) {
        const filename = entry.name.split('/').pop() || entry.name;
        files.push(new File(chunks, filename, { type: mimeType(filename) }));
      }
    };
    entry.start();
  });
  unzip.register(UnzipInflate);
  unzip.register(UnzipPassThrough);
  try {
    unzip.push(new Uint8Array(await archive.arrayBuffer()), true);
  } catch {
    throw new Error('The selected ZIP could not be read. Check that it is a valid ZIP archive.');
  }
  if (!files.length && !errors.length) errors.push('The ZIP does not contain any supported drawing or model files.');
  return { files, errors };
}

function identifyPuller(filename: string, pullers: Puller[]) {
  const base = filename.split('/').pop()?.replace(/\.[^.]+$/, '').toLocaleLowerCase() ?? '';
  return [...pullers]
    .sort((a, b) => b.uniqueIdentifier.length - a.uniqueIdentifier.length)
    .find((puller) => {
      const identifier = puller.uniqueIdentifier.toLocaleLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`(^|[^a-z0-9])${identifier}(?=$|[^a-z0-9])`).test(base);
    });
}

function templateDownload() {
  const content = `${csvHeaders.join(',')}\n`;
  const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'puller-import-template.csv';
  anchor.click();
  URL.revokeObjectURL(url);
}

function csvCell(value: string) {
  return `"${value.replace(/"/g, '""')}"`;
}

function rejectedRowsDownload(rows: ImportPreviewRow[]) {
  const rejected = rows.filter((row) => row.errors.length > 0);
  if (!rejected.length) return;

  const headers = [
    ...new Set(rejected.flatMap((row) => row.record.sourceHeaders)
      .filter((header) => normalizeHeader(header) !== 'validationerrors')),
    'validationErrors',
  ];
  const content = [
    headers.map(csvCell).join(','),
    ...rejected.map((row) => {
      const values = new Map(row.record.sourceHeaders.flatMap((header, index) =>
        normalizeHeader(header) === 'validationerrors'
          ? []
          : [[header, row.record.sourceValues[index] ?? ''] as const],
      ));
      return [
        ...headers.map((header) => normalizeHeader(header) === 'validationerrors'
          ? row.errors.join(' ')
          : values.get(header) ?? ''),
      ].map(csvCell).join(',');
    }),
  ].join('\r\n');
  const url = URL.createObjectURL(new Blob([`\uFEFF${content}\r\n`], { type: 'text/csv;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'puller-import-rejected-rows.csv';
  anchor.click();
  URL.revokeObjectURL(url);
}

function errorMessage(error: unknown) {
  const serverMessage = (error as { data?: { error?: string } })?.data?.error;
  return serverMessage || (error instanceof Error ? error.message : 'Import could not be completed. Please try again.');
}

export function PullerBulkImportDialog({
  onClose,
  onImported,
}: {
  onClose: () => void;
  onImported: (count: number) => void;
}) {
  const [csvFile, setCsvFile] = useState<File>();
  const [correctionCsvFile, setCorrectionCsvFile] = useState<File>();
  const [zipFile, setZipFile] = useState<File>();
  const [rows, setRows] = useState<ImportPreviewRow[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [catalogue, setCatalogue] = useState<Puller[]>([]);
  const [catalogueLoading, setCatalogueLoading] = useState(true);
  const [catalogueError, setCatalogueError] = useState('');
  const [previewLoading, setPreviewLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uploadedFiles, setUploadedFiles] = useState(0);
  const [saveError, setSaveError] = useState('');
  const csvInput = useRef<HTMLInputElement>(null);
  const zipInput = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();
  const importMutation = useBulkImportPullers();
  const { uploadFile, isUploading, progress } = useUpload();

  useEffect(() => {
    let cancelled = false;
    async function loadCatalogue() {
      try {
        const firstPage = await listPullers({ page: 1, limit: 100, sort: 'identifier' });
        const all = [...firstPage.items];
        for (let page = 2; all.length < firstPage.total; page += 1) {
          const response = await listPullers({ page, limit: 100, sort: 'identifier' });
          all.push(...response.items);
          if (!response.items.length) break;
        }
        if (!cancelled) setCatalogue(all);
      } catch {
        if (!cancelled) setCatalogueError('The puller catalogue could not be loaded. Close this dialog and try again.');
      } finally {
        if (!cancelled) setCatalogueLoading(false);
      }
    }
    void loadCatalogue();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function buildPreview() {
      if (!csvFile || catalogueLoading) return;
      if (catalogueError) {
        setErrors([catalogueError]);
        setRows([]);
        return;
      }
      setPreviewLoading(true);
      setRows([]);
      setErrors([]);
      try {
        if (csvFile.size > MAX_CSV_BYTES) throw new Error('The CSV must be 2 MB or smaller.');
        if (correctionCsvFile && correctionCsvFile.size > MAX_CORRECTION_CSV_BYTES) {
          throw new Error('The corrected rows CSV must be 4 MB or smaller.');
        }
        const parsed = readCsv(await csvFile.text());
        const correctionParsed = correctionCsvFile ? readCsv(await correctionCsvFile.text()) : undefined;
        const nextErrors = [...parsed.errors, ...(correctionParsed?.errors ?? [])];
        const byIdentifier = new Map(catalogue.map((puller) => [puller.uniqueIdentifier.toLocaleLowerCase(), puller]));
        const toPreviewRow = (record: CsvRecord): ImportPreviewRow => {
          const puller = byIdentifier.get(record.uniqueIdentifier.toLocaleLowerCase());
          const rowErrors = [...record.errors];
          if (!puller) rowErrors.push(`No existing puller has identifier "${record.uniqueIdentifier}".`);
          else {
            for (const [field, value] of Object.entries(record.specifications)) {
              const existing = puller[field as keyof Puller];
              if (existing != null && existing !== value) {
                rowErrors.push(`${field} already has a different value.`);
              }
            }
          }
          return { record, puller, media: {}, errors: rowErrors };
        };
        const originalRows = parsed.records.map(toPreviewRow);
        const keptOriginalRows = correctionCsvFile
          ? originalRows.filter((row) => row.errors.length === 0)
          : originalRows;
        const correctionRows = correctionParsed?.records.map(toPreviewRow) ?? [];
        if (correctionCsvFile) {
          const keptPullerIds = new Set(keptOriginalRows.map((row) => row.puller?.id).filter((id): id is number => id !== undefined));
          for (const row of correctionRows) {
            if (row.puller && keptPullerIds.has(row.puller.id)) {
              row.errors.push('This puller is already included as a valid row from the original CSV.');
            }
          }
        }
        const previewRows = [...keptOriginalRows, ...correctionRows];

        if (zipFile) {
          const extracted = await extractZip(zipFile);
          nextErrors.push(...extracted.errors);
          const seen = new Set<string>();
          for (const file of extracted.files) {
            const puller = identifyPuller(file.name, catalogue);
            if (!puller) {
              nextErrors.push(`ZIP entry "${file.name}" does not start with an existing puller identifier.`);
              continue;
            }
            const row = previewRows.find((candidate) => candidate.puller?.id === puller.id);
            if (!row) {
              nextErrors.push(`ZIP entry "${file.name}" matches ${puller.uniqueIdentifier}, which is not included in the CSV.`);
              continue;
            }
            const kind = mediaType(file.name);
            if (!kind) continue;
            const slotKey = `${puller.id}:${kind}`;
            if (seen.has(slotKey)) {
              row.errors.push(`More than one ${kind === 'drawing2d' ? '2D drawing' : '3D model'} file matches this puller.`);
              continue;
            }
            seen.add(slotKey);
            if (puller[`${kind}Url`] || puller[`${kind}Name`]) {
              row.errors.push(`${kind === 'drawing2d' ? 'A 2D drawing' : 'A 3D model'} already exists; it will not be replaced.`);
              continue;
            }
            row.media[kind] = file;
          }
        }

        for (const row of previewRows) {
          if (!Object.keys(row.record.specifications).length && !row.media.drawing2d && !row.media.drawing3d) {
            row.errors.push('Add at least one specification value or matching drawing/model file.');
          }
        }
        if (!cancelled) {
          setRows(previewRows);
          setErrors(nextErrors);
        }
      } catch (error) {
        if (!cancelled) setErrors([error instanceof Error ? error.message : 'The import files could not be read.']);
      } finally {
        if (!cancelled) setPreviewLoading(false);
      }
    }
    void buildPreview();
    return () => { cancelled = true; };
  }, [csvFile, correctionCsvFile, zipFile, catalogue, catalogueError, catalogueLoading]);

  const errorCount = errors.length + rows.reduce((count, row) => count + row.errors.length, 0);
  const validRows = useMemo(() => rows.filter((row) => row.errors.length === 0), [rows]);
  const mediaCount = rows.reduce((count, row) => count + Number(!!row.media.drawing2d) + Number(!!row.media.drawing3d), 0);
  const ready = rows.length > 0 && !errorCount && !catalogueLoading && !previewLoading;

  const saveImport = async () => {
    if (!ready) return;
    setSaving(true);
    setSaveError('');
    setUploadedFiles(0);
    const uploadedObjectPaths: string[] = [];
    let importCommitted = false;
    try {
      const items: PullerBulkImportItem[] = [];
      for (const row of validRows) {
        const item: PullerBulkImportItem = {
          pullerId: row.puller!.id,
          specifications: Object.keys(row.record.specifications).length ? row.record.specifications : undefined,
        };
        for (const kind of ['drawing2d', 'drawing3d'] as const) {
          const file = row.media[kind];
          if (!file) continue;
          const uploaded = await uploadFile(file);
          if (!uploaded) throw new Error(`Could not upload "${file.name}". No puller records were changed.`);
          uploadedObjectPaths.push(uploaded.objectPath);
          item.media ??= {};
          item.media[`${kind}Url`] = uploaded.objectPath;
          item.media[`${kind}Name`] = file.name;
          setUploadedFiles((count) => count + 1);
        }
        items.push(item);
      }
      const result = await importMutation.mutateAsync({ data: { items } });
      importCommitted = true;
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: getListPullersQueryKey() }),
        queryClient.invalidateQueries({ queryKey: getGetDashboardQueryKey() }),
        ...items.map((item) => queryClient.invalidateQueries({ queryKey: getGetPullerQueryKey(item.pullerId) })),
      ]);
      onImported(result.importedCount);
    } catch (error) {
      let cleanupNotice = '';
      if (!importCommitted && uploadedObjectPaths.length) {
        try {
          const response = await fetch('/api/storage/uploads/cleanup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ objectPaths: uploadedObjectPaths }),
          });
          if (!response.ok) {
            throw new Error('Cleanup request failed');
          }
          const result = await response.json() as {
            failedCount?: number;
          };
          if (result.failedCount) {
            cleanupNotice = ' Some uploaded files could not be removed automatically.';
          }
        } catch {
          cleanupNotice = ' Some uploaded files may remain in storage because automatic cleanup failed.';
        }
      }
      setSaveError(`${errorMessage(error)}${cleanupNotice}`);
    } finally {
      setSaving(false);
    }
  };

  const busy = saving || isUploading;
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section className="modal bulk-import-modal" role="dialog" aria-modal="true" aria-labelledby="bulk-import-title">
      <header className="modal-head">
        <div><h2 id="bulk-import-title" className="modal-title">Bulk puller import</h2><div className="panel-caption">Add configuration and private drawings to existing pullers</div></div>
        <button className="btn ghost small" aria-label="Close import" disabled={busy} onClick={onClose}><X /></button>
      </header>
      <div className="modal-body">
        <div className="bulk-import-instructions">
          <strong>Use a CSV and an optional ZIP</strong>
          <span>The CSV identifier must match an existing puller. ZIP filenames must include the identifier as a separate segment, for example <code>PL-104_2D.pdf</code>, <code>drawing_PL-104.pdf</code>, or <code>PL-104_model.glb</code>.</span>
          <span>Only blank specification fields and empty drawing/model slots are filled. Existing values and files are never replaced.</span>
          <button type="button" className="btn small" onClick={templateDownload}><FileUp />Download CSV template</button>
        </div>
        <div className="bulk-file-grid">
          <div className="form-field">
            <label htmlFor="bulk-csv">Puller specifications (CSV) *</label>
            <input ref={csvInput} id="bulk-csv" type="file" accept=".csv,text/csv" disabled={busy} onChange={(event) => { setCsvFile(event.currentTarget.files?.[0]); setCorrectionCsvFile(undefined); event.currentTarget.value = ''; }} />
          </div>
          {!!rows.some((row) => row.errors.length > 0) || correctionCsvFile ? <div className="form-field">
            <label htmlFor="bulk-correction-csv">Corrected rejected rows (CSV, optional)</label>
            <input id="bulk-correction-csv" type="file" accept=".csv,text/csv" disabled={busy} onChange={(event) => { setCorrectionCsvFile(event.currentTarget.files?.[0]); event.currentTarget.value = ''; }} />
            {correctionCsvFile && <small>Valid rows from the original CSV will be kept; rejected rows will be replaced with rows from {correctionCsvFile.name}.</small>}
          </div> : null}
          <div className="form-field">
            <label htmlFor="bulk-zip">Drawings and models (ZIP, optional)</label>
            <input ref={zipInput} id="bulk-zip" type="file" accept=".zip,application/zip" disabled={busy} onChange={(event) => { setZipFile(event.currentTarget.files?.[0]); event.currentTarget.value = ''; }} />
          </div>
        </div>
        {catalogueLoading && <p className="bulk-status" role="status"><LoaderCircle className="spin" size={15} />Loading puller identifiers…</p>}
        {previewLoading && <p className="bulk-status" role="status"><LoaderCircle className="spin" size={15} />Validating CSV and matching ZIP files…</p>}
        {(errors.length > 0 || rows.some((row) => row.errors.length > 0)) && <div className="bulk-errors" role="alert">
          <strong>{errorCount} issue{errorCount === 1 ? '' : 's'} need attention before import</strong>
          {errors.map((error, index) => <div key={`file-${index}`}>{error}</div>)}
          {rows.some((row) => row.errors.length > 0) && <button type="button" className="btn small" onClick={() => rejectedRowsDownload(rows)}><Download />Download rejected rows</button>}
        </div>}
        {!!rows.length && <div className="bulk-preview">
          <div className="bulk-preview-head"><strong>Import preview</strong><span>{validRows.length} of {rows.length} rows ready · {mediaCount} media file{mediaCount === 1 ? '' : 's'}</span></div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>CSV row</th><th>Puller</th><th>Specifications</th><th>2D drawing</th><th>3D model</th><th>Validation</th></tr></thead>
              <tbody>{rows.map((row) => <tr key={`${row.record.line}-${row.record.uniqueIdentifier}`}>
                <td>{row.record.line}</td>
                <td><strong>{row.record.uniqueIdentifier}</strong><small>{row.puller?.partName || 'No match'}</small></td>
                <td>{Object.keys(row.record.specifications).length || '—'}</td>
                <td>{row.media.drawing2d?.name || (row.puller?.drawing2dUrl || row.puller?.drawing2dName ? 'Already attached' : '—')}</td>
                <td>{row.media.drawing3d?.name || (row.puller?.drawing3dUrl || row.puller?.drawing3dName ? 'Already attached' : '—')}</td>
                <td>{row.errors.length ? <span className="bulk-row-error">{row.errors.join(' ')}</span> : <span className="bulk-row-ready">Ready</span>}</td>
              </tr>)}</tbody>
            </table>
          </div>
        </div>}
        {saveError && <p className="bulk-save-error" role="alert">{saveError}</p>}
        {busy && <div className="bulk-status" role="status"><LoaderCircle className="spin" size={15} />{isUploading ? `Uploading media ${uploadedFiles + 1} of ${mediaCount}… ${progress}%` : 'Saving imported specifications…'}</div>}
        <div className="modal-actions">
          <button type="button" className="btn" disabled={busy} onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={!ready || busy} onClick={() => { void saveImport(); }}>
            {busy ? <LoaderCircle className="spin" /> : <UploadCloud />}
            {busy ? 'Importing…' : `Import ${validRows.length || 0} puller${validRows.length === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </section>
  </div>;
}
