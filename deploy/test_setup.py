"""Offline unit tests: no sockets, containers or external downloads."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('oracle_setup', Path(__file__).with_name('setup.py'))
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)


class Response(io.BytesIO):
    def __init__(self, content=b'', status=200, **headers):
        super().__init__(content)
        self.status = status
        self.headers = headers


class SetupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.content = b'License and fixture original\n'
        self.artifact = {'path': 'licenses/source.txt', 'bytes': len(self.content),
                         'sha256': hashlib.sha256(self.content).hexdigest(), 'kind': 'license',
                         'urls': ['https://example.org/pinned.txt'],
                         'rights': {'acquisition': 'permitted', 'redistribution': 'permitted',
                                    'evidence': ['https://example.org/license'], 'notice': 'licenses/source.txt'}}
        self.vectors = {'name': 'dense-vectors', 'target': 'index_workspace_bytes',
                        'location': 'index-storage', 'bytes': 0,
                        'derivation': 'exact', 'formula': 'entries-x-width',
                        'inputs': {'entries': 0, 'dimensions': 384, 'bytes_per_dimension': 4},
                        'basis': 'fixture archive with no indexed entries'}
        self.release = {'schema_version': 2, 'id': 'fixture-v1', 'artifacts': [self.artifact],
                        'index_workspace_bytes': 0, 'runtime_workspace_bytes': 0, 'image_store_bytes': 0,
                        'footprint': {'components': [self.vectors]}}
        self.bundle = self.base / 'bundle'
        (self.bundle / 'objects').mkdir(parents=True)
        (self.bundle / 'objects' / self.artifact['sha256']).write_bytes(self.content)

    def test_offline_roundtrip_and_inventory_never_claims_active(self):
        root = self.base / 'data'
        with patch.object(setup.urllib.request, 'urlopen', side_effect=AssertionError('network')):
            generation = setup.prepare(root, self.release, self.bundle)
            self.assertEqual((generation / self.artifact['path']).read_bytes(), self.content)
            inventory = json.loads((root / 'inventory.json').read_text())
            self.assertEqual(inventory['releases']['fixture-v1']['status'], 'prepared')
            exported = self.base / 'export'
            setup.export_bundle(root, self.release, exported)
            setup.prepare(self.base / 'destination', self.release, exported)
        self.assertFalse((root / 'active.json').exists())

    def test_corrupt_offline_original_is_never_promoted(self):
        (self.bundle / 'objects' / self.artifact['sha256']).write_bytes(b'broken')
        with self.assertRaises(setup.SetupError):
            setup.prepare(self.base / 'data', self.release, self.bundle)
        self.assertFalse((self.base / 'data' / 'objects' / self.artifact['sha256']).exists())

    def test_rights_gate_blocks_export(self):
        root = self.base / 'data'
        setup.prepare(root, self.release, self.bundle)
        self.artifact['rights']['redistribution'] = 'unresolved'
        with self.assertRaisesRegex(setup.SetupError, 'clearance'):
            setup.export_bundle(root, self.release, self.base / 'export')
        self.assertFalse((self.base / 'export').exists())

    def test_unsafe_path_and_missing_notice_refused(self):
        self.artifact['path'] = '../outside'
        with self.assertRaises(setup.SetupError):
            setup.validate(self.release)
        self.artifact['path'] = 'source.pdf'
        with self.assertRaisesRegex(setup.SetupError, 'notice'):
            setup.validate(self.release)

    def test_low_disk_stops_before_acquisition(self):
        with patch.object(setup.shutil, 'disk_usage') as disk:
            disk.return_value.free = 0
            with self.assertRaisesRegex(setup.SetupError, 'Insufficient'):
                setup.prepare(self.base / 'data', self.release, self.bundle)
        self.assertFalse((self.base / 'data' / 'objects' / self.artifact['sha256']).exists())

    def test_validated_resume_and_changed_validator_restart(self):
        staging = self.base / 'staging'
        staging.mkdir()
        partial = staging / (self.artifact['sha256'] + '.part')
        partial.write_bytes(self.content[:5])
        receipt = {'url': self.artifact['urls'][0], 'etag': '"v1"', 'sha256': self.artifact['sha256'], 'bytes': len(self.content)}
        setup.atomic_json(staging / (self.artifact['sha256'] + '.json'), receipt)
        def resume(request, **kwargs):
            if request.get_method() == 'HEAD':
                return Response(ETag='"v1"', **{'Content-Length': str(len(self.content))})
            self.assertEqual(request.get_header('Range'), 'bytes=5-')
            self.assertEqual(request.get_header('If-range'), '"v1"')
            return Response(self.content[5:], status=206, ETag='"v1"', **{'Content-Range': f'bytes 5-{len(self.content)-1}/{len(self.content)}'})
        self.assertEqual(setup.transfer(self.artifact, staging, resume).read_bytes(), self.content)
        partial.write_bytes(self.content[:5])
        def restart(request, **kwargs):
            if request.get_method() == 'HEAD':
                return Response(ETag='"v2"')
            self.assertIsNone(request.get_header('Range'))
            return Response(self.content, ETag='"v2"')
        self.assertEqual(setup.transfer(self.artifact, staging, restart).read_bytes(), self.content)

    def test_hash_mismatch_never_publishes(self):
        staging = self.base / 'staging'
        staging.mkdir()
        def corrupt(request, **kwargs):
            if request.get_method() == 'HEAD':
                return Response(ETag='"v1"')
            return Response(b'x' * len(self.content), ETag='"v1"')
        with self.assertRaisesRegex(setup.SetupError, 'SHA-256'):
            setup.transfer(self.artifact, staging, corrupt)
        self.assertFalse((staging / (self.artifact['sha256'] + '.part')).exists())

    def test_release_id_immutable(self):
        root = self.base / 'data'
        setup.prepare(root, self.release, self.bundle)
        self.vectors['inputs']['entries'] = 1
        self.vectors['bytes'] = self.release['index_workspace_bytes'] = 1536
        with self.assertRaisesRegex(setup.SetupError, 'rebound'):
            setup.prepare(root, self.release, self.bundle)

    def candidate(self, host='127.0.0.1'):
        image = 'example/runtime@sha256:' + 'a' * 64
        compose = {'services': {'runtime': {'image': image, 'pull_policy': 'never',
                   'networks': ['offline'], 'ports': [host + ':9800:9800'],
                   'environment': {'HF_HUB_OFFLINE': '1', 'TRANSFORMERS_OFFLINE': '1', 'QUALIFICATION_MODE': '1'}}},
                   'networks': {'offline': {'internal': True}}}
        (self.base / 'compose.json').write_text(json.dumps(compose))
        self.release.update(qualification_candidate=True, compose='compose.json')
        self.release['artifacts'].extend([{'path': 'compose.json', 'kind': 'application'},
                                         {'path': 'image.tar', 'kind': 'image', 'image': image, 'image_id': 'sha256:' + 'b' * 64}])

    def test_candidate_start_is_separate_and_does_not_require_admission(self):
        self.candidate()
        with patch.object(setup.shutil, 'which', return_value='docker'), \
             patch.object(setup.subprocess, 'check_output', side_effect=[json.dumps({'DockerRootDir': str(self.base)}).encode(), json.dumps([{'Id': 'sha256:' + 'b' * 64}]).encode(), 'fixture-container\n', json.dumps([{'Name': '/fixture-container', 'HostConfig': {'PortBindings': {'9800/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '9800'}]}}, 'NetworkSettings': {'Ports': {'9800/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '9800'}]}, 'Networks': {'offline': {'IPAddress': '172.20.0.2'}}}}]).encode()]), \
             patch.object(setup.subprocess, 'run') as run:
            setup.start(self.base, self.release, self.base, qualification=True)
        self.assertTrue((self.base / 'candidate.json').exists())
        self.assertFalse((self.base / 'active.json').exists())
        generated = json.loads((self.base / 'runtime' / 'fixture-v1.candidate.compose.json').read_text())
        self.assertEqual(generated['services']['runtime']['environment']['QUALIFICATION_BOUNDARY'], 'isolated-container')
        self.assertEqual(generated['services']['runtime']['image'], 'sha256:' + 'b' * 64)
        self.assertNotIn('QUALIFICATION_BOUNDARY', json.loads((self.base / 'compose.json').read_text())['services']['runtime']['environment'])
        self.assertIn('oracle-qualification-fixture-v1', run.call_args.args[0])

    def test_candidate_cannot_bind_public_port(self):
        self.candidate('0.0.0.0')
        with patch.object(setup.subprocess, 'run') as run:
            with self.assertRaisesRegex(setup.SetupError, '127.0.0.1'):
                setup.start(self.base, self.release, self.base, qualification=True)
        run.assert_not_called()

    def test_shared_filesystem_adds_image_and_data_reservations(self):
        self.release['footprint']['components'].append(
            {'name': 'images', 'target': 'image_store_bytes', 'location': 'image-store', 'bytes': 80, 'derivation': 'exact',
             'formula': 'entries-x-bytes-each', 'inputs': {'entries': 8, 'bytes_each': 10},
             'basis': 'fixture expanded image layers'})
        self.release['image_store_bytes'] = 80
        with patch.object(setup, 'docker_store', return_value=('docker', self.base)), \
             patch.object(setup.shutil, 'disk_usage') as disk:
            disk.return_value.free = 100
            with self.assertRaisesRegex(setup.SetupError, 'expanded container images'):
                setup.preflight(self.base, self.release, [self.artifact])

    def test_materialize_pulls_digest_saves_image_id_and_records_real_bytes(self):
        image = 'example/runtime@sha256:' + 'a' * 64
        image_id = 'sha256:' + 'b' * 64
        recipe = {'schema_version': 1, 'images': [{'image': image, 'path': 'images/runtime.tar',
                  'archive_reserve_bytes': 1000, 'image_store_reserve_bytes': 1000,
                  'rights': self.artifact['rights']}]}
        def run(command, **kwargs):
            if command[1] == 'save':
                self.assertEqual(command[-1], image_id)
                Path(command[3]).write_bytes(b'actual saved image fixture')
        with patch.object(setup, 'docker_store', return_value=('docker', self.base)), \
             patch.object(setup.subprocess, 'check_output', return_value=json.dumps([{'RepoDigests': [image], 'Id': image_id, 'Size': 80}]).encode()), \
             patch.object(setup.subprocess, 'run', side_effect=run) as runner:
            setup.materialize_images(self.base, recipe)
            receipt = json.loads((self.base / 'image-artifacts.json').read_text())['artifacts'][0]
            self.assertEqual(receipt['bytes'], len(b'actual saved image fixture'))
            self.assertEqual(receipt['image_id'], image_id)
            self.assertTrue(setup.verify(self.base / 'objects' / receipt['sha256'], receipt))
            self.assertFalse(any(call.args[0][1] == 'compose' for call in runner.call_args_list))

    def test_image_materialization_disk_failure_precedes_pull(self):
        recipe = {'schema_version': 1, 'images': [{'image': 'example/runtime@sha256:' + 'a' * 64,
                  'path': 'images/runtime.tar', 'archive_reserve_bytes': 80,
                  'image_store_reserve_bytes': 80, 'rights': self.artifact['rights']}]}
        with patch.object(setup, 'docker_store', return_value=('docker', self.base)), \
             patch.object(setup.shutil, 'disk_usage') as disk, \
             patch.object(setup.subprocess, 'check_output', side_effect=AssertionError('Image inspection reached before disk admission')), \
             patch.object(setup.subprocess, 'run') as run:
            disk.return_value.free = 100
            with self.assertRaisesRegex(setup.SetupError, 'Insufficient'):
                setup.materialize_images(self.base, recipe)
            run.assert_not_called()

    def test_embedded_notice_is_pinned_and_requires_no_network(self):
        self.artifact['embedded_text'] = self.content.decode()
        with patch.object(setup, 'transfer', side_effect=AssertionError('network')):
            setup.prepare(self.base / 'embedded-data', self.release)
        self.artifact['embedded_text'] += 'tampered'
        with self.assertRaisesRegex(setup.SetupError, 'Embedded'):
            setup.validate(self.release)

    def test_capture_container_cache_verifies_bytes_and_omits_source_from_receipt(self):
        artifact = dict(self.artifact, kind='speech', capture={'container': 'decoder-1', 'path': '/cache/weights.bin'})
        def copy(command, **kwargs):
            self.assertEqual(command[:3], ['docker', 'cp', '-L'])
            Path(command[-1]).write_bytes(self.content)
        with patch.object(setup.shutil, 'which', return_value='docker'), \
             patch.object(setup.subprocess, 'run', side_effect=copy):
            setup.capture_assets(self.base, {'schema_version': 1, 'artifacts': [artifact]})
        receipt = json.loads((self.base / 'captured-artifacts.json').read_text())
        self.assertNotIn('capture', receipt['artifacts'][0])
        self.assertTrue(setup.verify(self.base / 'objects' / artifact['sha256'], artifact))

    def test_checked_copy_preserves_original_mtime_for_index_receipts(self):
        source = self.bundle / 'objects' / self.artifact['sha256']
        import os
        os.utime(source, ns=(1234567890123456789, 1234567890123456789))
        target = self.base / 'copied'
        setup.checked_copy(source, target, self.artifact)
        self.assertEqual(target.stat().st_mtime_ns, source.stat().st_mtime_ns)

    def test_local_image_capture_never_pulls_or_reserves_existing_store(self):
        image = 'example/runtime@sha256:' + 'a' * 64
        image_id = 'sha256:' + 'b' * 64
        recipe = {'schema_version': 1, 'images': [{'image': image, 'path': 'images/runtime.tar',
                  'archive_reserve_bytes': 1000, 'image_store_reserve_bytes': 0, 'local_only': True,
                  'rights': self.artifact['rights']}]}
        def run(command, **kwargs):
            self.assertEqual(command[1], 'save')
            Path(command[3]).write_bytes(b'local image archive')
        with patch.object(setup, 'docker_store', return_value=('docker', self.base)), \
             patch.object(setup.subprocess, 'check_output', return_value=json.dumps([{'RepoDigests': [image], 'Id': image_id, 'Size': 5000}]).encode()), \
             patch.object(setup.subprocess, 'run', side_effect=run) as runner:
            setup.materialize_images(self.base, recipe)
            self.assertEqual(runner.call_count, 1)

    def segmented_fixture(self):
        a = dict(self.artifact, path='fixture.txt', metalink='https://example.org/fixture.meta4')
        chunks = [self.content[i:i+4] for i in range(0, len(self.content), 4)]
        xml = ('<metalink xmlns="urn:ietf:params:xml:ns:metalink"><file name="fixture.txt">'
               f'<size>{len(self.content)}</size><hash type="sha-256">{a["sha256"]}</hash>'
               '<pieces length="4" type="sha-1">' + ''.join('<hash>'+hashlib.sha1(c).hexdigest()+'</hash>' for c in chunks)
               + '</pieces><url>'+a['urls'][0]+'</url></file></metalink>').encode()
        requested = []
        def opener(request, **kwargs):
            if isinstance(request, str):
                return Response(xml)
            if request.get_method() == 'HEAD':
                return Response(ETag='"v1"', **{'Content-Length': str(len(self.content))})
            start, stop = map(int, request.get_header('Range').removeprefix('bytes=').split('-'))
            requested.append(start // 4)
            self.assertEqual(request.get_header('If-match'), '"v1"')
            return Response(self.content[start:stop+1], status=206, ETag='"v1"', **{'Content-Range': f'bytes {start}-{stop}/{len(self.content)}'})
        return a, opener, requested

    def test_segmented_migration_preserves_single_file_and_rechecks_piece_hashes(self):
        a, opener, requested = self.segmented_fixture()
        staging = self.base / 'staging'
        staging.mkdir()
        serial = staging / (a['sha256'] + '.part')
        serial.write_bytes(self.content[:8] + b'xxxx')
        inode = serial.stat().st_ino
        setup.atomic_json(staging / (a['sha256'] + '.json'), {'sha256': a['sha256'], 'bytes': a['bytes'], 'etag': '"v1"'})
        result = setup.segmented_transfer(a, staging, 3, opener)
        self.assertEqual(result.read_bytes(), self.content)
        self.assertEqual(result.stat().st_ino, inode)
        self.assertFalse(serial.exists())
        self.assertNotIn(0, requested)
        self.assertNotIn(1, requested)
        self.assertIn(2, requested)
        data = bytearray(result.read_bytes()); data[0] ^= 1; result.write_bytes(data)
        requested.clear()
        self.assertEqual(setup.segmented_transfer(a, staging, 2, opener).read_bytes(), self.content)
        self.assertEqual(requested, [0])

    def test_segmented_bad_validator_never_completes(self):
        a, original, requested = self.segmented_fixture()
        staging = self.base / 'staging'
        staging.mkdir()
        def opener(request, **kwargs):
            response = original(request, **kwargs)
            if not isinstance(request, str) and request.get_method() != 'HEAD':
                response.headers['ETag'] = '"changed"'
            return response
        with self.assertRaisesRegex(setup.SetupError, 'validator mismatch'):
            setup.segmented_transfer(a, staging, 2, opener)
        state = json.loads((staging / (a['sha256'] + '.segments.json')).read_text())
        self.assertEqual(state['completed'], [])

    def test_missing_internal_network_publication_fails_visibly(self):
        self.candidate()
        inspections = [json.dumps({'DockerRootDir': str(self.base)}).encode(),
                       json.dumps([{'Id': 'sha256:' + 'b' * 64}]).encode(), 'fixture-container\n',
                       json.dumps([{'Name': '/fixture-container', 'HostConfig': {'PortBindings': {'9800/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '9800'}]}}, 'NetworkSettings': {'Ports': {'9800/tcp': None}, 'Networks': {'offline': {'IPAddress': '172.20.0.2'}}}}]).encode()]
        with patch.object(setup.shutil, 'which', return_value='docker'), \
             patch.object(setup.subprocess, 'check_output', side_effect=inspections), \
             patch.object(setup.subprocess, 'run'):
            with self.assertRaisesRegex(setup.SetupError, 'did not publish'):
                setup.start(self.base, self.release, self.base, qualification=True)
        receipt = json.loads((self.base / 'candidate.json').read_text())
        self.assertEqual(receipt['status'], 'failed-port-publication')
        self.assertEqual(receipt['internal_addresses']['fixture-container']['offline'], '172.20.0.2')
        self.assertFalse((self.base / 'active.json').exists())

    def test_unqualified_release_cannot_launch(self):
        with self.assertRaisesRegex(setup.SetupError, 'not qualified'):
            setup.start(self.base, self.release, self.base)


class FootprintTests(unittest.TestCase):
    """A reservation is only worth trusting if its number is reproduced from a stated basis."""

    def setUp(self):
        SetupTests.setUp(self)
        self.vectors['inputs']['entries'] = 1000
        self.vectors['bytes'] = 1536000
        self.spans = {'name': 'passage-spans', 'target': 'index_workspace_bytes',
                      'location': 'index-storage', 'bytes': 3190000,
                      'derivation': 'measured-mean', 'formula': 'entries-x-bytes-each',
                      'inputs': {'entries': 1000, 'bytes_each': 3190},
                      'basis': 'the measured mean stored size per article'}
        self.headroom = {'name': 'headroom', 'target': 'index_workspace_bytes',
                         'location': 'index-storage', 'bytes': 307200,
                         'derivation': 'upstream-formula', 'formula': 'fraction-of-components',
                         'inputs': {'components': ['dense-vectors'], 'numerator': 1, 'denominator': 5},
                         'basis': 'the storage headroom the vector store asks for'}
        self.release['footprint']['components'] = [self.vectors, self.spans, self.headroom]
        self.release['index_workspace_bytes'] = 1536000 + 3190000 + 307200

    def test_declared_scalar_cannot_exceed_its_itemization(self):
        self.release['index_workspace_bytes'] += 1
        with self.assertRaisesRegex(setup.SetupError, 'index_workspace_bytes must equal'):
            setup.validate(self.release)

    def test_component_cannot_contradict_its_own_derivation(self):
        self.spans['bytes'] = self.release['index_workspace_bytes'] = 1
        with self.assertRaisesRegex(setup.SetupError, 'contradicts its own derivation'):
            setup.validate(self.release)

    def test_unmeasured_component_may_not_smuggle_in_a_number(self):
        self.spans['derivation'] = 'unmeasured'
        with self.assertRaisesRegex(setup.SetupError, 'cannot declare a byte count'):
            setup.validate(self.release)

    def test_component_without_a_basis_is_refused(self):
        self.spans['basis'] = '   '
        with self.assertRaisesRegex(setup.SetupError, 'must state the evidence'):
            setup.validate(self.release)

    def test_fraction_cannot_precede_what_it_is_a_fraction_of(self):
        self.release['footprint']['components'] = [self.headroom, self.vectors, self.spans]
        with self.assertRaisesRegex(setup.SetupError, 'does not follow'):
            setup.validate(self.release)

    def test_predecessor_schema_is_refused_rather_than_read_as_zero_cost(self):
        self.release['schema_version'] = 1
        with self.assertRaisesRegex(setup.SetupError, 'Unsupported release schema'):
            setup.validate(self.release)

    def test_indexing_cost_is_reserved_before_any_download(self):
        with patch.object(setup.shutil, 'disk_usage') as disk:
            disk.return_value.free = len(self.content) + self.release['index_workspace_bytes'] - 1
            with self.assertRaisesRegex(setup.SetupError, 'Insufficient'):
                setup.preflight(self.base, self.release, [self.artifact])
            disk.return_value.free = len(self.content) + self.release['index_workspace_bytes']
            report = setup.preflight(self.base, self.release, [self.artifact])
        self.assertEqual(report['footprint']['components']['passage-spans'], 3190000)

    def test_a_refusal_names_the_itemization_and_the_way_out(self):
        with patch.object(setup.shutil, 'disk_usage') as disk:
            disk.return_value.free = 0
            with self.assertRaisesRegex(setup.SetupError, r'passage-spans=3190000.*--without'):
                setup.preflight(self.base, self.release, [self.artifact])

    def test_omitting_a_component_drops_it_and_its_share_of_a_fraction(self):
        with patch.object(setup.shutil, 'disk_usage') as disk:
            disk.return_value.free = len(self.content) + 3190000
            report = setup.preflight(self.base, self.release, [self.artifact],
                                     omitted=('dense-vectors',))
        self.assertEqual(report['footprint']['components'], {'passage-spans': 3190000, 'headroom': 0})

    def test_omitting_an_undeclared_component_is_refused(self):
        with self.assertRaisesRegex(setup.SetupError, 'not declared by this release'):
            setup.preflight(self.base, self.release, [self.artifact], omitted=('dense-vecotrs',))

    def test_a_component_must_say_which_filesystem_holds_it(self):
        del self.spans['location']
        with self.assertRaisesRegex(setup.SetupError, 'must name the filesystem'):
            setup.validate(self.release)

    def test_a_fraction_cannot_span_reservations_or_filesystems(self):
        self.spans['location'] = 'content-state'
        self.headroom['inputs']['components'] = ['dense-vectors', 'passage-spans']
        self.headroom['bytes'] = (1536000 + 3190000) // 5
        self.release['index_workspace_bytes'] = 1536000 + 3190000 + self.headroom['bytes']
        with self.assertRaisesRegex(setup.SetupError, 'reserved elsewhere: passage-spans'):
            setup.validate(self.release)

    def test_a_malformed_input_is_refused_rather_than_raised_through(self):
        for value, complaint in (("1000", 'whole number'), (1000.0, 'whole number'), (-1, 'whole number')):
            with self.subTest(value=value):
                self.vectors['inputs']['entries'] = value
                with self.assertRaisesRegex(setup.SetupError, complaint):
                    setup.validate(self.release)
        self.vectors['inputs']['entries'] = 1000
        self.headroom['inputs']['denominator'] = 0
        with self.assertRaisesRegex(setup.SetupError, 'positive denominator'):
            setup.validate(self.release)
        self.headroom['inputs']['denominator'] = 5
        self.headroom['inputs']['components'] = 'dense-vectors'
        with self.assertRaisesRegex(setup.SetupError, 'must name the components'):
            setup.validate(self.release)

    def test_index_bytes_are_charged_to_the_vector_store_and_not_to_the_data_root(self):
        self.spans['location'] = 'content-state'
        recorded = []
        with patch.object(setup, 'check_space', side_effect=lambda r: recorded.extend(r) or []):
            setup.preflight(self.base, self.release, [self.artifact],
                            content_state=self.base / 'state', index_storage=self.base / 'qdrant')
        charged = {label: (path, needed) for path, needed, label in recorded}
        self.assertEqual(charged['acquired artifacts'][1], len(self.content))
        # Neither directory exists yet, so each resolves to the filesystem that will hold it.
        self.assertEqual(charged['index storage'], (self.base.resolve(), 1536000 + 307200))
        self.assertEqual(charged['content state'], (self.base.resolve(), 3190000))

    def test_one_filesystem_is_asked_for_the_total_once(self):
        """The same bytes reserved under two labels must not be demanded twice."""
        self.spans['location'] = 'content-state'
        # Three distinct directories that happen to share one filesystem, which is the
        # ordinary layout and the case a per-label reservation would double-charge.
        state, qdrant = self.base / 'state', self.base / 'qdrant'
        state.mkdir()
        qdrant.mkdir()
        total = len(self.content) + self.release['index_workspace_bytes']
        with patch.object(setup.shutil, 'disk_usage') as disk:
            disk.return_value.free = total
            report = setup.preflight(self.base, self.release, [self.artifact],
                                     content_state=state, index_storage=qdrant)
        self.assertEqual([group['required_bytes'] for group in report['filesystems']], [total])

    def test_an_unstated_location_is_named_rather_than_assumed_silently(self):
        self.spans['location'] = 'content-state'
        with patch.object(setup.shutil, 'disk_usage') as disk:
            disk.return_value.free = 1 << 40
            report = setup.preflight(self.base, self.release, [self.artifact])
        self.assertEqual(report['footprint']['assumed_under_data_root'], ['content-state', 'index-storage'])
        self.assertEqual(report['footprint']['by_location']['index-storage'], 1536000 + 307200)

    def test_a_target_directory_that_does_not_exist_yet_resolves_to_its_filesystem(self):
        self.assertEqual(setup.hosting_device(self.base / 'absent' / 'deeper'), self.base.resolve())

    def test_every_shipped_pack_reproduces_its_own_numbers(self):
        packs = [p for p in sorted((Path(__file__).parent / 'packs').glob('*.json'))
                 if not p.name.endswith('.recipe.json')]
        self.assertTrue(packs)
        for release in [json.loads(p.read_text()) for p in packs]:
            with self.subTest(release=release['id']):
                setup.validate(release)


if __name__ == '__main__':
    unittest.main()
