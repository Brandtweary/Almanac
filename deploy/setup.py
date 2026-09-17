#!/usr/bin/env python3
"""One Linux setup entry for verified releases and portable offline bundles."""
from __future__ import annotations

import argparse
import concurrent.futures
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import urllib.request
import xml.etree.ElementTree as ET


class SetupError(Exception):
    pass


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.tmp')
    with temporary.open('w') as stream:
        json.dump(value, stream, indent=2, sort_keys=True)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)
    descriptor = os.open(path.parent, os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def relative(value):
    if not isinstance(value, str) or not value or '\\' in value:
        raise SetupError('Expected a portable relative path')
    path = Path(value)
    if path.is_absolute() or any(p in ('..', '.') for p in value.split('/')):
        raise SetupError(f'Unsafe relative path: {value}')
    return path


def validate(release):
    if release.get('schema_version') != 1:
        raise SetupError('Unsupported release schema')
    if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9._-]*', release.get('id', '')):
        raise SetupError('Invalid release identity')
    artifacts = release.get('artifacts', [])
    if not artifacts:
        raise SetupError('Release has no pinned artifacts')
    names = set()
    for artifact in artifacts:
        path = str(relative(artifact['path']))
        if path in names or any(path.startswith(p + '/') or p.startswith(path + '/') for p in names):
            raise SetupError('Duplicate or overlapping artifact path')
        names.add(path)
        if not re.fullmatch('[a-f0-9]{64}', artifact.get('sha256', '')):
            raise SetupError(f'Missing SHA-256: {path}')
        if type(artifact.get('bytes')) is not int or artifact['bytes'] <= 0:
            raise SetupError(f'Missing exact byte size: {path}')
        if artifact.get('kind') == 'image' and (not re.fullmatch(r'[^\s@]+@sha256:[a-f0-9]{64}', artifact.get('image', '')) or not re.fullmatch(r'sha256:[a-f0-9]{64}', artifact.get('image_id', ''))):
            raise SetupError(f'Image archive requires upstream digest and measured image ID: {path}')
        if 'embedded_text' in artifact:
            embedded = artifact['embedded_text']
            if not isinstance(embedded, str) or artifact.get('kind') not in ('license', 'application'):
                raise SetupError('Only text notices/configuration may be embedded')
            payload = embedded.encode('utf-8')
            if len(payload) != artifact['bytes'] or hashlib.sha256(payload).hexdigest() != artifact['sha256']:
                raise SetupError('Embedded artifact does not match its pinned bytes/hash')
        rights = artifact.get('rights', {})
        if rights.get('acquisition') not in ('permitted', 'user-supplied') or not rights.get('evidence'):
            raise SetupError(f'Acquisition rights unresolved: {path}')
        if not rights.get('notice'):
            raise SetupError(f'Missing local rights notice: {path}')
        if rights['notice'] not in [a.get('path') for a in artifacts]:
            raise SetupError(f'Rights notice must be an included artifact: {path}')
        for url in artifact.get('urls', []):
            if not url.startswith('https://'):
                raise SetupError('Downloads require HTTPS; offline copies use --offline-bundle')
    for key in ('index_workspace_bytes', 'runtime_workspace_bytes', 'image_store_bytes'):
        if type(release.get(key)) is not int or release[key] < 0:
            raise SetupError(f'Release must specify measured {key}')
    return artifacts


def verify(path, artifact):
    return path.is_file() and not path.is_symlink() and path.stat().st_size == artifact['bytes'] and digest(path) == artifact['sha256']


def checked_copy(source, target, artifact):
    if not verify(source, artifact):
        raise SetupError(f'Offline artifact failed verification: {artifact["path"]}')
    target.parent.mkdir(parents=True, exist_ok=True)
    with source.open('rb') as inp, target.open('wb') as out:
        shutil.copyfileobj(inp, out, 1024 * 1024)
        out.flush()
        os.fsync(out.fileno())
    source_stat = source.stat()
    os.utime(target, ns=(source_stat.st_atime_ns, source_stat.st_mtime_ns))


def transfer(artifact, staging, opener=urllib.request.urlopen):
    """Resume only within an unchanged URL and a strong upstream validator."""
    partial = staging / (artifact['sha256'] + '.part')
    receipt = staging / (artifact['sha256'] + '.json')
    errors = []
    for url in artifact.get('urls', []):
        try:
            old = json.loads(receipt.read_text()) if receipt.exists() else {}
            with opener(urllib.request.Request(url, method='HEAD'), timeout=60) as head:
                etag = head.headers.get('ETag')
                validator = etag if etag and not etag.startswith('W/') else None
                identity = {'url': url, 'etag': validator, 'sha256': artifact['sha256'], 'bytes': artifact['bytes']}
                length = head.headers.get('Content-Length')
                if length and int(length) != artifact['bytes']:
                    raise SetupError('Upstream size changed')
            offset = partial.stat().st_size if partial.exists() and old == identity and validator else 0
            if offset >= artifact['bytes']:
                if verify(partial, artifact):
                    return partial
                offset = 0
            if not offset:
                partial.write_bytes(b'')
            atomic_json(receipt, identity)
            headers = {'Accept-Encoding': 'identity'}
            if offset:
                headers.update({'Range': f'bytes={offset}-', 'If-Range': validator})
            with opener(urllib.request.Request(url, headers=headers), timeout=60) as response:
                if offset:
                    expected = f'bytes {offset}-{artifact["bytes"] - 1}/{artifact["bytes"]}'
                    if response.status != 206 or response.headers.get('Content-Range') != expected:
                        partial.unlink(missing_ok=True)
                        raise SetupError('Server did not honor validated resume; rerun to restart')
                    if response.headers.get('ETag') != validator:
                        partial.unlink(missing_ok=True)
                        raise SetupError('Source validator changed during resume')
                elif response.status != 200:
                    raise SetupError('Unexpected download response')
                with partial.open('ab' if offset else 'wb') as stream:
                    total = offset
                    while block := response.read(1024 * 1024):
                        total += len(block)
                        if total > artifact['bytes']:
                            raise SetupError('Download exceeds pinned size')
                        stream.write(block)
                    stream.flush()
                    os.fsync(stream.fileno())
            if not verify(partial, artifact):
                partial.unlink(missing_ok=True)
                raise SetupError('Downloaded bytes failed SHA-256 or size verification')
            return partial
        except (OSError, ValueError, SetupError) as error:
            errors.append(f'{url}: {error}')
    raise SetupError('Unable to acquire ' + artifact['path'] + ': ' + '; '.join(errors))


def segmented_transfer(artifact, staging, connections, opener=urllib.request.urlopen):
    """Verify metalink pieces and write disjoint ranges into one owned file."""
    metadata_url = artifact.get('metalink')
    if not metadata_url or not metadata_url.startswith('https://'):
        raise SetupError('Segmented acquisition requires HTTPS metalink with piece hashes')
    with opener(metadata_url, timeout=60) as response:
        metadata = response.read(16 * 1024 * 1024 + 1)
    if len(metadata) > 16 * 1024 * 1024:
        raise SetupError('Metalink metadata exceeds parser limit')
    ns = {'m': 'urn:ietf:params:xml:ns:metalink'}
    document = ET.fromstring(metadata)
    file = document.find('m:file', ns)
    if file is None or file.attrib.get('name') != Path(artifact['path']).name:
        raise SetupError('Metalink file identity mismatch')
    if int(file.find('m:size', ns).text) != artifact['bytes'] or file.find("m:hash[@type='sha-256']", ns).text != artifact['sha256']:
        raise SetupError('Metalink does not match pinned complete artifact')
    pieces = file.find("m:pieces[@type='sha-1']", ns)
    if pieces is None:
        raise SetupError('Metalink has no supported piece integrity table')
    chunk_bytes = int(pieces.attrib['length'])
    if chunk_bytes <= 0 or chunk_bytes > 64 * 1024 * 1024:
        raise SetupError('Unsupported metalink piece size')
    hashes = [node.text for node in pieces.findall('m:hash', ns)]
    if len(hashes) != (artifact['bytes'] + chunk_bytes - 1) // chunk_bytes or any(not re.fullmatch('[a-f0-9]{40}', h or '') for h in hashes):
        raise SetupError('Invalid metalink piece table')
    available_urls = {node.text for node in file.findall('m:url', ns)}
    url = artifact['urls'][0]
    if url not in available_urls:
        raise SetupError('Selected segmented mirror is absent from pinned-file metalink')
    with opener(urllib.request.Request(url, method='HEAD'), timeout=60) as response:
        etag = response.headers.get('ETag')
        if not etag or etag.startswith('W/') or response.headers.get('Content-Length') != str(artifact['bytes']):
            raise SetupError('Segmented acquisition requires strong validator and exact size')
    identity = {'url': url, 'etag': etag, 'sha256': artifact['sha256'], 'bytes': artifact['bytes'],
                'chunk_bytes': chunk_bytes, 'piece_table_sha256': hashlib.sha256(''.join(hashes).encode()).hexdigest()}
    partial = staging / (artifact['sha256'] + '.segments.part')
    state_path = staging / (artifact['sha256'] + '.segments.json')
    state = json.loads(state_path.read_text()) if state_path.exists() else None
    if state and any(state.get(key) != value for key, value in identity.items()):
        raise SetupError('Segmented source identity changed; partial retained without reuse')
    if not partial.exists():
        serial = staging / (artifact['sha256'] + '.part')
        serial_receipt = staging / (artifact['sha256'] + '.json')
        if serial.exists():
            receipt = json.loads(serial_receipt.read_text()) if serial_receipt.exists() else {}
            if receipt.get('sha256') != artifact['sha256'] or receipt.get('bytes') != artifact['bytes'] or receipt.get('etag') != etag:
                raise SetupError('Serial partial identity differs; retained without reuse')
            serial.replace(partial)
        else:
            partial.touch()
    descriptor = os.open(partial, os.O_RDWR)
    completed = set()
    try:
        if state:
            candidates = state.get('completed', [])
            if any(type(i) is not int or i < 0 or i >= len(hashes) for i in candidates):
                raise SetupError('Invalid persisted segment indices')
        else:
            # A migrated serial file is contiguous; sparse files always carry state.
            candidates = range(min(len(hashes), partial.stat().st_size // chunk_bytes))
        for index in candidates:
            size = min(chunk_bytes, artifact['bytes'] - index * chunk_bytes)
            payload = os.pread(descriptor, size, index * chunk_bytes)
            if len(payload) == size and hashlib.sha1(payload).hexdigest() == hashes[index]:
                completed.add(index)
        def save():
            os.fsync(descriptor)
            atomic_json(state_path, dict(identity, completed=sorted(completed),
                        verified_bytes=sum(min(chunk_bytes, artifact['bytes'] - i * chunk_bytes) for i in completed)))
        save()
        def fetch(index):
            start = index * chunk_bytes
            stop = min(start + chunk_bytes, artifact['bytes']) - 1
            headers = {'Range': f'bytes={start}-{stop}', 'If-Match': etag, 'Accept-Encoding': 'identity'}
            last_error = None
            for attempt in range(3):
                try:
                    with opener(urllib.request.Request(url, headers=headers), timeout=30) as response:
                        if response.status != 206 or response.headers.get('Content-Range') != f'bytes {start}-{stop}/{artifact["bytes"]}' or response.headers.get('ETag') != etag:
                            raise SetupError('Segment range or source validator mismatch')
                        payload = response.read(stop - start + 2)
                    if len(payload) != stop - start + 1 or hashlib.sha1(payload).hexdigest() != hashes[index]:
                        raise SetupError('Segment failed upstream piece checksum')
                    written = 0
                    while written < len(payload):
                        count = os.pwrite(descriptor, payload[written:], start + written)
                        if count <= 0:
                            raise SetupError('Segment write made no progress')
                        written += count
                    return index
                except (OSError, SetupError) as error:
                    last_error = error
            raise SetupError(f'Segment {index} failed after three attempts: {last_error}')
        pending_indices = iter(i for i in range(len(hashes)) if i not in completed)
        pool = concurrent.futures.ThreadPoolExecutor(max_workers=connections)
        pending = set()
        try:
            for _ in range(connections):
                index = next(pending_indices, None)
                if index is not None:
                    pending.add(pool.submit(fetch, index))
            since_save = 0
            while pending:
                done, pending = concurrent.futures.wait(pending, return_when=concurrent.futures.FIRST_COMPLETED)
                for future in done:
                    completed.add(future.result())
                    since_save += 1
                    index = next(pending_indices, None)
                    if index is not None:
                        pending.add(pool.submit(fetch, index))
                if since_save >= 32:
                    save()
                    since_save = 0
            save()
        finally:
            pool.shutdown(wait=True, cancel_futures=True)
    finally:
        os.close(descriptor)
    if not verify(partial, artifact):
        raise SetupError('Complete segmented artifact failed final SHA-256; retained for diagnosis')
    return partial


def docker_store():
    engine = shutil.which('docker')
    if not engine:
        raise SetupError('Install Docker Engine and Compose before image preparation or startup')
    info = json.loads(subprocess.check_output([engine, 'info', '--format', '{{json .}}']))
    image_root = Path(info['DockerRootDir'])
    if not image_root.is_dir():
        raise SetupError('Cannot inspect Docker image-store filesystem')
    return engine, image_root


def check_space(reservations):
    """Add reservations sharing a filesystem before comparing with available bytes."""
    groups = {}
    for path, needed, label in reservations:
        device = path.stat().st_dev
        free = shutil.disk_usage(path).free
        group = groups.setdefault(device, {'required_bytes': 0, 'free_bytes': free, 'purposes': []})
        group['required_bytes'] += needed
        group['free_bytes'] = min(group['free_bytes'], free)
        group['purposes'].append(label)
    for group in groups.values():
        if group['free_bytes'] < group['required_bytes']:
            raise SetupError(f"Insufficient disk for {', '.join(group['purposes'])}: need {group['required_bytes']} additional bytes, have {group['free_bytes']}; no packs omitted")
    return list(groups.values())


def preflight(root, release, artifacts, include_image_store=True, export_destination=None):
    unique = {a['sha256']: a for a in artifacts}
    missing = sum(a['bytes'] for a in unique.values() if not verify(root / 'objects' / a['sha256'], a))
    reserve = release['index_workspace_bytes'] + release['runtime_workspace_bytes']
    reservations = [(root, missing + reserve, 'data artifacts and workspace')]
    if include_image_store and release['image_store_bytes']:
        _, image_root = docker_store()
        reservations.append((image_root, release['image_store_bytes'], 'expanded container images'))
    if export_destination:
        export_destination.parent.mkdir(parents=True, exist_ok=True)
        if export_destination.exists() or export_destination.with_name(export_destination.name + '.partial').exists():
            raise SetupError('Export destination or partial already exists')
        reservations.append((export_destination.parent, sum(a['bytes'] for a in unique.values()) + 1024 * 1024, 'portable bundle copy and metadata'))
    disks = check_space(reservations)
    return {'download_bytes_upper_bound': missing, 'filesystems': disks}


def capture_assets(root, recipe):
    """Capture explicitly named immutable files, including container-layer caches."""
    if recipe.get('schema_version') != 1 or not recipe.get('artifacts'):
        raise SetupError('Asset capture requires schema_version 1 and pinned artifacts')
    artifacts = recipe['artifacts']
    for artifact in artifacts:
        relative(artifact['path'])
        if not re.fullmatch('[a-f0-9]{64}', artifact.get('sha256', '')) or type(artifact.get('bytes')) is not int or artifact['bytes'] <= 0:
            raise SetupError('Captured assets require exact upstream SHA-256 and size')
        source = artifact.get('capture', {})
        if ('file' in source) == ('container' in source):
            raise SetupError('Capture requires exactly one local file or container source')
        if 'container' in source and (not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]*', source['container']) or not str(source.get('path', '')).startswith('/')):
            raise SetupError('Container capture requires an exact container identity and absolute internal path')
    missing = [a for a in artifacts if not verify(root / 'objects' / a['sha256'], a)]
    check_space([(root, sum(a['bytes'] for a in missing), 'captured offline runtime assets')])
    (root / 'objects').mkdir(exist_ok=True)
    (root / 'staging').mkdir(exist_ok=True)
    receipt = {'schema_version': 1, 'status': 'captured-not-release-qualified', 'artifacts': []}
    for artifact in artifacts:
        target = root / 'objects' / artifact['sha256']
        if not verify(target, artifact):
            temporary = root / 'staging' / (artifact['sha256'] + '.capture.part')
            source = artifact['capture']
            if 'file' in source:
                checked_copy(Path(source['file']).resolve(), temporary, artifact)
            else:
                engine = shutil.which('docker')
                if not engine:
                    raise SetupError('Docker is required to capture container-layer assets')
                # Docker dereferences the selected snapshot symlink, not the whole cache.
                subprocess.run([engine, 'cp', '-L', source['container'] + ':' + source['path'], str(temporary)], check=True)
                if not verify(temporary, artifact):
                    raise SetupError('Captured container file differs from pinned upstream bytes')
            temporary.replace(target)
        portable = {key: value for key, value in artifact.items() if key != 'capture'}
        receipt['artifacts'].append(portable)
        atomic_json(root / 'captured-artifacts.json', receipt)
    print(f'Captured {len(artifacts)} pinned assets; no services changed')


def materialize_images(root, recipe, reserve_bytes=0):
    """Connected preparation only: acquire digest pins and measure saved archives."""
    if recipe.get('schema_version') != 1 or not recipe.get('images'):
        raise SetupError('Image recipe requires schema_version 1 and image entries')
    engine, image_root = docker_store()
    if type(reserve_bytes) is not int or reserve_bytes < 0:
        raise SetupError('Additional reservation must be a nonnegative byte count')
    reservations = [(root, reserve_bytes, 'concurrent artifact work')]
    paths = set()
    for item in recipe['images']:
        if not re.fullmatch(r'[^\s@]+@sha256:[a-f0-9]{64}', item.get('image', '')):
            raise SetupError('Image preparation requires an immutable repository digest')
        path = str(relative(item['path']))
        if path in paths:
            raise SetupError('Duplicate prepared image path')
        paths.add(path)
        for key in ('archive_reserve_bytes', 'image_store_reserve_bytes'):
            minimum = 0 if key == 'image_store_reserve_bytes' and item.get('local_only') is True else 1
            if type(item.get(key)) is not int or item[key] < minimum:
                raise SetupError(f'Image preparation requires explicit {key} >= {minimum}')
        rights = item.get('rights', {})
        if rights.get('acquisition') != 'permitted' or not rights.get('evidence'):
            raise SetupError('Image acquisition rights require evidence')
        relative(rights.get('notice'))
        reservations.extend([(root, item['archive_reserve_bytes'], 'saved image archive'),
                             (image_root, item['image_store_reserve_bytes'], 'expanded image store')])
    print(json.dumps({'image_preparation_filesystems': check_space(reservations)}, indent=2))
    (root / 'objects').mkdir(exist_ok=True)
    (root / 'staging').mkdir(exist_ok=True)
    receipt_path = root / 'image-artifacts.json'
    existing = json.loads(receipt_path.read_text()) if receipt_path.exists() else {'schema_version': 1, 'artifacts': []}
    for item in recipe['images']:
        prior = next((a for a in existing['artifacts'] if a.get('image') == item['image'] and a['path'] == item['path'] and a['rights'] == item['rights']), None)
        if prior and verify(root / 'objects' / prior['sha256'], prior):
            continue
        if not item.get('local_only'):
            subprocess.run([engine, 'pull', item['image']], check=True)
        inspection = json.loads(subprocess.check_output([engine, 'image', 'inspect', item['image']]))
        if not inspection or item['image'] not in inspection[0].get('RepoDigests', []):
            raise SetupError('Pulled image does not expose the pinned repository digest')
        if not item.get('local_only') and inspection[0]['Size'] > item['image_store_reserve_bytes']:
            raise SetupError('Expanded image exceeds its declared storage reservation')
        temporary = root / 'staging' / (item['image'].split(':')[-1] + '.image.part')
        image_id = inspection[0]['Id']
        if not re.fullmatch(r'sha256:[a-f0-9]{64}', image_id):
            raise SetupError('Image inspection did not return an immutable image ID')
        subprocess.run([engine, 'save', '--output', str(temporary), image_id], check=True)
        size = temporary.stat().st_size
        if size <= 0 or size > item['archive_reserve_bytes']:
            raise SetupError('Saved image archive exceeds its declared storage reservation or is empty')
        sha = digest(temporary)
        artifact = {'path': item['path'], 'bytes': size, 'sha256': sha, 'kind': 'image',
                    'image': item['image'], 'image_id': image_id, 'urls': [], 'rights': item['rights']}
        temporary.replace(root / 'objects' / sha)
        existing['artifacts'] = [a for a in existing['artifacts'] if a['path'] != item['path']] + [artifact]
        atomic_json(receipt_path, existing)
    print(f'Image artifacts measured and saved in {receipt_path}; no services started')


def prepare(root, release, bundle=None, include_image_store=True, export_destination=None, connections=1):
    artifacts = validate(release)
    if bundle and bundle.name.endswith('.partial'):
        raise SetupError('Incomplete export cannot be imported')
    root.mkdir(parents=True, exist_ok=True)
    for folder in ('objects', 'staging', 'releases'):
        (root / folder).mkdir(exist_ok=True)
    print(json.dumps(preflight(root, release, artifacts, include_image_store, export_destination), indent=2))
    inventory_path = root / 'inventory.json'
    inventory = json.loads(inventory_path.read_text()) if inventory_path.exists() else {'schema_version': 1, 'releases': {}}
    generation = root / 'releases' / release['id']
    if (generation / 'release.json').exists() and json.loads((generation / 'release.json').read_text()) != release:
        raise SetupError('A release ID cannot be rebound to different content')
    generation.mkdir(exist_ok=True)
    rows = []
    for artifact in artifacts:
        target = root / 'objects' / artifact['sha256']
        if not verify(target, artifact):
            if 'embedded_text' in artifact and not bundle:
                temporary = root / 'staging' / (artifact['sha256'] + '.part')
                with temporary.open('wb') as output_stream:
                    output_stream.write(artifact['embedded_text'].encode('utf-8'))
                    output_stream.flush()
                    os.fsync(output_stream.fileno())
            elif bundle:
                temporary = root / 'staging' / (artifact['sha256'] + '.part')
                checked_copy(bundle / 'objects' / artifact['sha256'], temporary, artifact)
            else:
                temporary = segmented_transfer(artifact, root / 'staging', connections) if connections > 1 and artifact.get('metalink') else transfer(artifact, root / 'staging')
            temporary.replace(target)
        output = generation / relative(artifact['path'])
        output.parent.mkdir(parents=True, exist_ok=True)
        if output.exists() or output.is_symlink():
            if output.is_symlink() and output.resolve() == target.resolve():
                pass
            else:
                raise SetupError(f'Unexpected existing release file: {output}')
        else:
            output.symlink_to(os.path.relpath(target, output.parent))
        rows.append({'path': artifact['path'], 'sha256': artifact['sha256'], 'bytes': artifact['bytes'],
                     'kind': artifact['kind'], 'status': 'content-only' if artifact['kind'] == 'map' else 'verified',
                     'rights': artifact['rights']})
        inventory['releases'][release['id']] = {'status': 'preparing', 'artifacts': rows}
        atomic_json(inventory_path, inventory)
    atomic_json(generation / 'release.json', release)
    inventory['releases'][release['id']]['status'] = 'prepared'
    atomic_json(inventory_path, inventory)
    return generation


def export_bundle(root, release, destination):
    artifacts = validate(release)
    denied = [a['path'] for a in artifacts if a['rights'].get('redistribution') != 'permitted']
    if denied:
        raise SetupError('Bundle redistribution clearance missing: ' + ', '.join(denied))
    if destination.exists():
        raise SetupError('Export destination must be new; an incomplete bundle is never overwritten')
    destination.parent.mkdir(parents=True, exist_ok=True)
    size = sum({a['sha256']: a['bytes'] for a in artifacts}.values())
    if shutil.disk_usage(destination.parent).free < size:
        raise SetupError(f'Bundle export requires {size} additional bytes')
    temporary = destination.with_name(destination.name + '.partial')
    temporary.mkdir()
    try:
        for artifact in artifacts:
            target = temporary / 'objects' / artifact['sha256']
            checked_copy(root / 'objects' / artifact['sha256'], target, artifact)
        atomic_json(temporary / 'release.json', release)
        shutil.copyfile(__file__, temporary / 'setup.py')
        atomic_json(temporary / 'bundle.json', {'schema_version': 1, 'release_sha256': digest(temporary / 'release.json'), 'setup_sha256': digest(temporary / 'setup.py')})
        temporary.replace(destination)
    except BaseException:
        # Retain the labelled partial for diagnosis; it is not an importable bundle.
        raise


def start(root, release, generation, qualification=False):
    required = {'application', 'image', 'model', 'tokenizer', 'speech', 'extraction', 'corpus', 'index', 'license'}
    missing = required - {a['kind'] for a in release['artifacts']}
    if not qualification and (missing or not release.get('qualification', {}).get('offline_smoke_passed')):
        raise SetupError('Release is not qualified for offline start; missing categories: ' + ', '.join(sorted(missing)))
    wikipedia = release.get('wikipedia', {})
    if not qualification and (wikipedia.get('flavour') not in ('maxi', 'nopic') or wikipedia.get('path') not in {a['path'] for a in release['artifacts'] if a['kind'] == 'corpus'}):
        raise SetupError('Release requires complete-article Wikipedia: maxi or explicit nopic')
    compose_artifact = next((a for a in release['artifacts'] if a['path'] == release.get('compose')), None)
    if not compose_artifact:
        raise SetupError('Compose configuration must be a pinned release artifact')
    if qualification and not release.get('qualification_candidate'):
        raise SetupError('Qualification start requires an explicitly labelled candidate manifest')
    compose_path = generation / relative(release['compose'])
    compose = json.loads(compose_path.read_text())
    images = {a.get('image') for a in release['artifacts'] if a['kind'] == 'image'}
    for name, service in compose.get('services', {}).items():
        image = service.get('image', '')
        if image not in images or not re.search(r'@sha256:[a-f0-9]{64}$', image):
            raise SetupError(f'Unpinned service image: {name}')
        if service.get('pull_policy') != 'never' or 'build' in service or service.get('network_mode'):
            raise SetupError(f'Service can download/build or bypass offline network: {name}')
        if qualification:
            for port in service.get('ports', []):
                if isinstance(port, str):
                    if not port.startswith('127.0.0.1:'):
                        raise SetupError('Qualification ports must bind 127.0.0.1')
                elif not isinstance(port, dict) or port.get('host_ip') != '127.0.0.1':
                    raise SetupError('Qualification ports must bind 127.0.0.1')
        networks = service.get('networks', [])
        if not networks or any(compose.get('networks', {}).get(n, {}).get('internal') is not True for n in networks):
            raise SetupError(f'Service requires an internal-only runtime network: {name}')
        for key in ('HF_HUB_OFFLINE', 'TRANSFORMERS_OFFLINE'):
            if str(service.get('environment', {}).get(key)) != '1':
                raise SetupError(f'Service must set {key}=1: {name}')
    if not compose.get('services'):
        raise SetupError('Release contains no services')
    engine, image_root = docker_store()
    check_space([(root, release['index_workspace_bytes'] + release['runtime_workspace_bytes'], 'runtime workspace'),
                 (image_root, release['image_store_bytes'], 'expanded container images')])
    for artifact in release['artifacts']:
        if artifact['kind'] == 'image':
            subprocess.run([engine, 'load', '--input', str(generation / artifact['path'])], check=True)
            expected_id = artifact.get('image_id', '')
            if not re.fullmatch(r'sha256:[a-f0-9]{64}', expected_id):
                raise SetupError('Saved image lacks its measured immutable image ID')
            loaded = json.loads(subprocess.check_output([engine, 'image', 'inspect', expected_id]))
            if not loaded or loaded[0].get('Id') != expected_id:
                raise SetupError('Loaded image identity does not match the prepared archive')
    image_ids = {a['image']: a['image_id'] for a in release['artifacts'] if a['kind'] == 'image'}
    for service in compose['services'].values():
        service['image'] = image_ids[service['image']]
        if qualification and str(service.get('environment', {}).get('QUALIFICATION_MODE')) == '1':
            service['environment']['QUALIFICATION_BOUNDARY'] = 'isolated-container'
    generated = root / 'runtime' / (release['id'] + ('.candidate' if qualification else '') + '.compose.json')
    atomic_json(generated, compose)
    compose_path = generated
    env = dict(os.environ, ORACLE_DATA_DIR=str(root.resolve()), HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1')
    project = ('oracle-qualification-' + release['id'].lower()) if qualification else 'local-oracle'
    compose_command = [engine, 'compose', '--project-name', project, '--file', str(compose_path), '--project-directory', str(generation)]
    subprocess.run([*compose_command, 'up', '-d', '--pull', 'never', '--no-build'], cwd=generation, env=env, check=True)
    identifiers = subprocess.check_output([*compose_command, 'ps', '--all', '--quiet'], cwd=generation, env=env, text=True).split()
    if not identifiers:
        raise SetupError('Compose returned without an inspectable runtime container')
    containers = json.loads(subprocess.check_output([engine, 'inspect', *identifiers]))
    missing_ports = []
    addresses = {}
    for container in containers:
        name = container.get('Name', '').lstrip('/')
        network = container.get('NetworkSettings', {})
        addresses[name] = {key: value.get('IPAddress') for key, value in network.get('Networks', {}).items()}
        for port, requested in container.get('HostConfig', {}).get('PortBindings', {}).items():
            if requested and not network.get('Ports', {}).get(port):
                missing_ports.append(f'{name}:{port}')
    record = {'release': release['id'], 'status': 'qualification-only' if qualification else 'started-not-health-verified', 'internal_addresses': addresses}
    if missing_ports:
        record.update(status='failed-port-publication', missing_ports=missing_ports)
    atomic_json(root / ('candidate.json' if qualification else 'active.json'), record)
    if missing_ports:
        raise SetupError('Docker did not publish requested ports on the internal-only network: ' + ', '.join(missing_ports) + '. Isolation is preserved; use a host gateway and inspected internal inference address as documented in docs/install.md. Containers remain started; this is not a ready installation.')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--connections', type=int, default=1, help='Parallel verified metalink ranges for selected acquisition; same single staging file')
    parser.add_argument('--capture-assets', type=Path, help='Capture pinned local/container files into offline objects; no downloads or service changes')
    parser.add_argument('--reserve-bytes', type=int, default=0, help='Additional data-filesystem reservation for concurrent work during connected image preparation')
    parser.add_argument('--materialize-images', type=Path, help='Connected digest-pinned image pull/save recipe; records actual archive hashes and sizes, never starts services')
    parser.add_argument('--release', type=Path, help='Pinned qualified release JSON')
    parser.add_argument('--data', type=Path, default=Path(os.environ.get('XDG_DATA_HOME', Path.home() / '.local/share')) / 'local-oracle')
    parser.add_argument('--offline-bundle', type=Path, help='Import an exported directory without network access')
    parser.add_argument('--export-bundle', type=Path, help='Prepare a portable verified bundle directory')
    parser.add_argument('--qualification', action='store_true', help='Start an explicitly labelled candidate on loopback for local evaluation; never mark production active')
    parser.add_argument('--prepare-only', action='store_true', help='Acquire assets without starting services')
    args = parser.parse_args(argv)
    if not 1 <= args.connections <= 16:
        parser.error('--connections must be between 1 and 16')
    if sum(bool(v) for v in (args.release, args.offline_bundle, args.materialize_images, args.capture_assets)) != 1:
        parser.error('Choose exactly one of --release, --offline-bundle, --materialize-images or --capture-assets')
    path = args.release or (args.offline_bundle / 'release.json' if args.offline_bundle else None)
    if args.reserve_bytes and not args.materialize_images:
        parser.error('--reserve-bytes applies to --materialize-images only')
    if (args.materialize_images or args.capture_assets) and (args.export_bundle or args.qualification):
        parser.error('--materialize-images only prepares image artifacts; it cannot export or start services')
    if args.offline_bundle:
        marker = json.loads((args.offline_bundle / 'bundle.json').read_text())
        if marker.get('release_sha256') != digest(path):
            raise SetupError('Offline bundle release manifest failed integrity check')
    release = json.loads(path.read_text()) if path else None
    args.data.mkdir(parents=True, exist_ok=True)
    with (args.data / '.setup.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise SetupError('Another setup process owns this data directory') from exc
        if args.capture_assets:
            capture_assets(args.data, json.loads(args.capture_assets.read_text()))
            return
        if args.materialize_images:
            materialize_images(args.data, json.loads(args.materialize_images.read_text()), args.reserve_bytes)
            return
        generation = prepare(args.data, release, args.offline_bundle, include_image_store=not (args.prepare_only or args.export_bundle), export_destination=args.export_bundle, connections=args.connections)
        if args.export_bundle:
            export_bundle(args.data, release, args.export_bundle)
        if not args.prepare_only and not args.export_bundle:
            start(args.data, release, generation, qualification=args.qualification)


if __name__ == '__main__':
    try:
        main()
    except (SetupError, OSError, ValueError, KeyError, subprocess.CalledProcessError) as error:
        print(f'Setup failed: {error}', file=sys.stderr)
        sys.exit(1)
