"""Filing-provided identities survive label changes without guessing aliases."""
import io
import zipfile
from unittest.mock import Mock

import pytest

from tradingagents.dataflows import public_financials as financials
from tradingagents.dataflows.public_data_common import evidence
from tradingagents.dataflows.public_evidence import assess_evidence


def labels_zip():
    pairs = [('ifrs-full_IssuedCapitalMember', 'Old capital label'),
             ('ifrs-full_IssuedCapitalMember', 'New capital label'),
             ('ifrs-full_IssuedCapitalMember', 'Ambiguous'),
             ('ifrs-full_RetainedEarningsMember', 'Ambiguous'),
             ('entity1_CustomMember', 'Custom')]
    xml = '<linkbase xmlns="http://www.xbrl.org/2003/linkbase" xmlns:x="http://www.w3.org/1999/xlink"><labelLink>'
    for i, (concept, label) in enumerate(pairs):
        xml += (f'<loc x:label="c{i}" x:href="schema#{concept}"/>'
                f'<label x:label="l{i}">{label}</label>'
                f'<labelArc x:from="c{i}" x:to="l{i}"/>')
    data = io.BytesIO()
    with zipfile.ZipFile(data, 'w') as archive:
        archive.writestr('filing_lab-ko.xml', xml + '</labelLink></linkbase>')
    return data.getvalue()


@pytest.mark.parametrize('unavailable', [False, True])
def test_filing_identity_is_used_and_download_failure_preserves_facts(monkeypatch, unavailable):
    monkeypatch.setenv('DART_API_KEY', 'secret')
    mapping = financials._dart_component_ids(labels_zip())
    assert mapping == {'Old capital label': 'ifrs-full_IssuedCapitalMember',
                       'New capital label': 'ifrs-full_IssuedCapitalMember'}
    def request(url, params):
        year = params['bsns_year']
        return {'status': '000', 'list': [{
            'rcept_no': '20260814000001' if year == '2026' else '20260314000001',
            'sj_div': 'SCE', 'account_id': 'dart_ChangesInConsolidatedCompanies',
            'account_nm': 'Changes', 'account_detail': 'Parent|' + ('New' if year == '2026' else 'Old') + ' capital label',
            'thstrm_amount': '100', 'currency': 'KRW'}]}
    monkeypatch.setattr(financials, 'request_json', request)
    monkeypatch.setattr(financials, '_request', Mock(
        side_effect=TimeoutError() if unavailable else None, return_value=Mock(content=labels_zip())))
    filings = [evidence('dart', 'TEST', {'report_name': name, 'receipt_number': '20260814000001'}, None,
                        published_at='2026-08-14')
               for name in ['반기보고서 (2026.06)', '사업보고서 (2025.12)']]
    rows = financials.dart_enrichment('1', 'TEST', '2026-09-17', filings)
    facts = [r for r in rows if r.get('statement') == 'SCE']
    assert len(facts) == 2
    assess_evidence(facts, '2026-09-17')
    old = next(r for r in facts if r['observed_at'] == '2025-12-31')
    assert bool(old.get('comparative_only')) is not unavailable
    assert old['stale']  # History never becomes a current observation.
    if unavailable:
        assert any('/component_identity' in r['target'] and r['status'] == 'error' for r in rows)
    else:
        facts[0]['component_id'] = 'ifrs-full_RetainedEarningsMember'
        assess_evidence(facts, '2026-09-17')
        assert not old.get('comparative_only')
    assert 'secret' not in str(rows)
