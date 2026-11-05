#!/usr/bin/env python3
"""Fixed native Docker mutations under the shared physical resource authority.
Never configures a daemon or cgroup; only preprovisioned disposable lab authority.
"""
import contextlib
import os
import time
import hashlib
import http.client
import json
import pathlib
import re
import socket
import sys
import uuid
from resource_authority import authority, reservation, validate_group, release, claim_operation, verify, ledger_path, _reservation_paths, _read_reservation, _write_reservation, _reobserve_membership

class UnixHTTP(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(8)
        self.sock.connect('/var/run/docker.sock')

def rpc(method, path, body=None, allowed=(200,)):
    client = UnixHTTP('localhost', timeout=8)
    try:
        encoded = None if body is None else json.dumps(body).encode()
        client.request(method, '/v1.44/' + path, encoded, {'Content-Type':'application/json'})
        response = client.getresponse()
        data = response.read(1048577)
        if len(data)>1048576 or response.status not in allowed:
            raise ValueError('NATIVE_RESOURCE_DOCKER_UNCERTAIN')
        return response.status, json.loads(data) if data else None
    finally:
        client.close()

def inspect(identifier):
    status, data = rpc('GET', 'containers/' + identifier + '/json', allowed=(200,404))
    return data if status==200 else None

def operation(config, name):
    if not re.fullmatch(r'ac-native-(?:plan|worker|tools|qa)-[a-f0-9-]{36}',name):
        raise ValueError('NATIVE_RESOURCE_NAME_INVALID')
    raw = hashlib.sha256((config['installationId']+'\0'+name).encode()).hexdigest()[:32]
    return str(uuid.UUID(raw))

def claim_path(config, op):
    key=hashlib.sha256((config['installationId']+'\0'+op).encode()).hexdigest()
    return ledger_path(config).parent/('operation-'+key+'.json')

def expected(config, physical):
    name=physical['Name'].removeprefix('/')
    op=operation(config,name)
    labels=physical['Config']['Labels']
    epoch=int(labels.get('ac.resources.epoch','0'))
    if not re.fullmatch(r'[a-f0-9]{64}',labels.get('ac.resources.request','')):
        raise ValueError('NATIVE_RESOURCE_REQUEST_MISMATCH')
    if not os.path.lexists(claim_path(config,op)):
        raise ValueError('NATIVE_RESOURCE_CLAIM_MISSING')
    # Existing claims must match immutable request digest, epoch and state-root identity.
    if claim_operation(config,op,epoch,labels['ac.resources.request'],config['_stateRoot']):
        raise ValueError('NATIVE_RESOURCE_CLAIM_MISSING')
    physical=validate_group(config,physical,op,epoch,inspect)
    return op,epoch,physical

@contextlib.contextmanager
def serialized_authority(config):
    deadline=time.monotonic()+15
    while True:
        guard=authority(config)
        try:
            guard.__enter__()
            break
        except ValueError as error:
            if str(error) not in ('RESOURCE_AUTHORITY_BUSY','RESOURCE_INSTALLATION_BUSY') or time.monotonic()>=deadline:raise
            time.sleep(0.05)
    try:yield
    finally:guard.__exit__(None,None,None)

def execute(request):
    config=request['authority']
    config['_stateRoot']=request['stateRoot']
    if not config['resourceAuthority']['authorityId'].startswith('ac-r3-resources-'):
        raise ValueError('NATIVE_RESOURCE_LAB_REQUIRED')
    action=request['action']
    if action=='recovery_sweep':
        try:config['_recoveryToken']=str(uuid.UUID(request['recoveryToken']))
        except (KeyError,TypeError,ValueError):raise ValueError('RECOVERY_RESOURCE_TOKEN_INVALID')
    with serialized_authority(config):
        value,parent=verify(config)
        anchor=inspect(value['anchorId'])
        if anchor['Config']['Labels'].get('ac.r3.disposable')!='true':
            raise ValueError('NATIVE_RESOURCE_LAB_REQUIRED')
        if action=='recovery_sweep':
            if not config.get('_recoveryToken'):raise ValueError('RECOVERY_RESOURCE_TOKEN_INVALID')
            # Full scope only: a pending create or another state root is not
            # evidence of absence. Authority lock and epoch fence span the
            # physical inventory, stop, verification and removal.
            slots=[_read_reservation(path) for path in _reservation_paths(config)]
            if any(slot.get('stateRoot')!=request['stateRoot'] or not re.fullmatch(r'[a-f0-9]{64}',str(slot.get('containerId',''))) for slot in slots):
                raise ValueError('RECOVERY_RESOURCE_INVENTORY_UNCERTAIN')
            ids=[item['Id'] for item in rpc('GET','containers/json?all=1')[1]
                 if (item.get('Labels') or {}).get('ac.resources.authority')==value['authorityId'] and item['Id']!=value['anchorId']]
            bound=[slot['containerId'] for slot in slots]
            if len(ids)!=len(bound) or set(ids)!=set(bound) or len(set(bound))!=len(bound):
                raise ValueError('RECOVERY_RESOURCE_INVENTORY_UNCERTAIN')
            if len(ids)>32:raise ValueError('RECOVERY_RESOURCE_INVENTORY_UNCERTAIN')
            key=hashlib.sha256((value['authorityId']+'\0'+config['_recoveryToken']).encode()).hexdigest()
            journal=ledger_path(config).parent/('recovery-sweep-'+key+'.json')
            if os.path.lexists(journal):
                previous=_read_reservation(journal)
                if previous.get('state')!='completed' or previous.get('epoch')!=config['authorityEpoch'] or ids or slots:
                    raise ValueError('RECOVERY_RESOURCE_INVENTORY_UNCERTAIN')
                return previous['proof']
            _write_reservation(journal,{'operationId':config['_recoveryToken'],'epoch':config['authorityEpoch'],'state':'started','containerIds':sorted(ids)},True)
            removed=[]
            for identifier in sorted(ids):
                physical=inspect(identifier)
                if physical is None or physical.get('Id')!=identifier:raise ValueError('RECOVERY_RESOURCE_INVENTORY_UNCERTAIN')
                op,epoch,physical=expected(config,physical)
                if physical['State']['Running']:
                    rpc('POST','containers/'+identifier+'/stop?t=3',allowed=(204,304))
                    physical=inspect(identifier)
                if physical is None or physical.get('Id')!=identifier:raise ValueError('RECOVERY_RESOURCE_INVENTORY_UNCERTAIN')
                _reobserve_membership(pathlib.Path('/sys/fs/cgroup')/parent,physical,inspect)
                rpc('DELETE','containers/'+identifier,allowed=(204,404))
                if inspect(identifier) is not None:raise ValueError('RECOVERY_RESOURCE_INVENTORY_UNCERTAIN')
                release(config,identifier,op,epoch)
                removed.append(identifier)
            if list(_reservation_paths(config)) or any((item.get('Labels') or {}).get('ac.resources.authority')==value['authorityId'] and item['Id']!=value['anchorId'] for item in rpc('GET','containers/json?all=1')[1]):
                raise ValueError('RECOVERY_RESOURCE_INVENTORY_UNCERTAIN')
            proof={'state':'neutralized','authorityId':value['authorityId'],'installationId':config['installationId'],
                   'anchorId':value['anchorId'],'epoch':config['authorityEpoch'],'stateRoot':request['stateRoot'],'containerIds':removed}
            _write_reservation(journal,{'operationId':config['_recoveryToken'],'epoch':config['authorityEpoch'],'state':'completed','proof':proof},False)
            return proof
        if action=='cancel_admission':
            names=request['names'];token=str(uuid.UUID(request['admissionId']));paths=[]
            for name in names:
                op=operation(config,name)
                if os.path.lexists(claim_path(config,op)) or inspect(name) is not None:raise ValueError('NATIVE_RESOURCE_ADMISSION_UNCERTAIN')
                for path in _reservation_paths(config):
                    slot=_read_reservation(path)
                    if slot['operationId']==op:
                        if slot.get('admissionId')!=token or slot.get('containerId') is not None or slot.get('stateRoot')!=request['stateRoot']:raise ValueError('NATIVE_RESOURCE_ADMISSION_UNCERTAIN')
                        paths.append(path)
            for path in paths:path.unlink()
            fd=os.open(ledger_path(config).parent,os.O_RDONLY|os.O_DIRECTORY)
            try:os.fsync(fd)
            finally:os.close(fd)
            return {'proof':'no_groups_no_create_claims'}
        if action=='admit':
            names=request['names'];token=str(uuid.UUID(request['admissionId']))
            if not isinstance(names,list) or not 1<=len(names)<=8 or len(set(names))!=len(names):
                raise ValueError('NATIVE_RESOURCE_BATCH_INVALID')
            operations=[operation(config,name) for name in names]
            slots=[_read_reservation(path) for path in _reservation_paths(config)]
            ids=rpc('GET','containers/json?all=1')[1]
            bound={slot.get('containerId') for slot in slots}
            untracked=[item['Id'] for item in ids if item['Labels'].get('ac.resources.authority')==value['authorityId'] and item['Id']!=value['anchorId'] and item['Id'] not in bound]
            existing=[slot for slot in slots if slot['operationId'] in operations]
            if existing:
                if len(existing)==len(names) and all(slot.get('admissionId')==token and slot.get('containerId') is None and slot.get('stateRoot')==request['stateRoot'] for slot in existing) and all(not os.path.lexists(claim_path(config,op)) and inspect(name) is None for op,name in zip(operations,names)):return {'admissionId':token}
                raise ValueError('NATIVE_RESOURCE_CREATE_UNCERTAIN')
            if len(names)>value['maxJobs']:raise ValueError('NATIVE_RESOURCE_BATCH_TOO_LARGE')
            if len(slots)+len(untracked)+len(names)>value['maxJobs']:raise ValueError('RESOURCE_CAPACITY_EXHAUSTED')
            for name,op in zip(names,operations):
                if os.path.lexists(claim_path(config,op)):raise ValueError('NATIVE_RESOURCE_CREATE_UNCERTAIN')
            for name,op in zip(names,operations):
                key=hashlib.sha256((op+':'+str(config['authorityEpoch'])).encode()).hexdigest()
                path=ledger_path(config).parent/('reservation-'+hashlib.sha256(value['authorityId'].encode()).hexdigest()[:24]+'-'+key+'.json')
                _write_reservation(path,{'authorityId':value['authorityId'],'operationId':op,'epoch':config['authorityEpoch'],'containerId':None,'admissionId':token,'stateRoot':request['stateRoot']},True)
            return {'admissionId':token}
        if action=='create':
            name=request['name'];op=operation(config,name);epoch=config['authorityEpoch']
            body=request['configuration']
            if not isinstance(body,dict) or not isinstance(body.get('HostConfig'),dict):
                raise ValueError('NATIVE_RESOURCE_CONFIGURATION_INVALID')
            if body['HostConfig'].get('CgroupParent') not in (None,parent):
                raise ValueError('NATIVE_RESOURCE_PARENT_OVERRIDE')
            labels=body.setdefault('Labels',{})
            if any(key.startswith('ac.resources.') for key in labels):
                raise ValueError('NATIVE_RESOURCE_LABEL_OVERRIDE')
            encoded=json.dumps(body,sort_keys=True,separators=(',',':')).encode()
            digest=hashlib.sha256(encoded).hexdigest()
            if os.path.lexists(claim_path(config,op)):
                claim_operation(config,op,epoch,digest,request['stateRoot'])
                raise ValueError('NATIVE_RESOURCE_CREATE_UNCERTAIN')
            def create_group():
                if not claim_operation(config,op,epoch,digest,request['stateRoot']):raise ValueError('NATIVE_RESOURCE_CREATE_UNCERTAIN')
                body['HostConfig']['CgroupParent']=parent
                labels.update({'ac.resources.authority':value['authorityId'],'ac.resources.operation':op,
                               'ac.resources.epoch':str(epoch),'ac.resources.request':digest,'ac.resources.installation':config['installationId']})
                return rpc('POST','containers/create?name='+name,body,allowed=(201,))[1]
            if request.get('admissionId'):
                key=hashlib.sha256((op+':'+str(epoch)).encode()).hexdigest()
                path=ledger_path(config).parent/('reservation-'+hashlib.sha256(value['authorityId'].encode()).hexdigest()[:24]+'-'+key+'.json')
                slot=_read_reservation(path)
                if slot.get('admissionId')!=request['admissionId'] or slot.get('stateRoot')!=request['stateRoot'] or slot.get('containerId') is not None:raise ValueError('NATIVE_RESOURCE_ADMISSION_MISMATCH')
                created=create_group();slot['containerId']=created['Id'];_write_reservation(path,slot,False)
            else:
                with reservation(config,op,epoch):created=create_group()
            physical=inspect(created['Id']);_,_,physical=expected(config,physical)
            return {'id':physical['Id']}
        identifier=request['id']
        if not re.fullmatch(r'[a-f0-9]{64}',identifier) and not re.fullmatch(r'ac-native-(?:plan|worker|tools|qa)-[a-f0-9-]{36}',identifier):
            raise ValueError('NATIVE_RESOURCE_ID_INVALID')
        physical=inspect(identifier)
        if physical is None:
            # Recover lost remove ACK only for an immutable ID already durably bound.
            matches=[];pending=False
            for path in _reservation_paths(config):
                slot=_read_reservation(path)
                if identifier.startswith('ac-native-') and slot['operationId']==operation(config,identifier) and not slot.get('containerId'):pending=True
                if (slot.get('containerId')==identifier or (identifier.startswith('ac-native-') and slot['operationId']==operation(config,identifier))) and slot.get('containerId'):
                    matches.append(slot)
            if pending:raise ValueError('NATIVE_RESOURCE_CREATE_UNCERTAIN')
            if len(matches)==1 and inspect(matches[0]['containerId']) is None:
                slot=matches[0];release(config,slot['containerId'],slot['operationId'],slot['epoch'])
                if action=='remove':return {'ok':True}
            if action=='inspect':return {'absent':True}
            if action=='remove' and re.fullmatch(r'[a-f0-9]{64}',identifier):return {'ok':True}
            # Absence without the bound operation metadata cannot release a pending admission.
            raise ValueError('NATIVE_RESOURCE_GROUP_ABSENT')
        op,epoch,physical=expected(config,physical)
        identifier=physical['Id']
        if action=='inspect':return {'physical':physical}
        if action=='start':
            rpc('POST','containers/'+identifier+'/start',allowed=(204,304))
            expected(config,inspect(identifier))
        elif action=='stop':
            rpc('POST','containers/'+identifier+'/stop?t=3',allowed=(204,304))
            expected(config,inspect(identifier))
        elif action=='remove':
            # Never --force: established native retirement must first prove terminal state.
            if physical['State']['Running']:raise ValueError('NATIVE_RESOURCE_GROUP_RUNNING')
            rpc('DELETE','containers/'+identifier,allowed=(204,404))
            release(config,identifier,op,epoch)
        else:raise ValueError('NATIVE_RESOURCE_ACTION_INVALID')
        return {'ok':True}

def main():
    try:
        raw=sys.stdin.buffer.read(2097153)
        if len(raw)>2097152:raise ValueError('NATIVE_RESOURCE_REQUEST_TOO_LARGE')
        result=execute(json.loads(raw))
        print(json.dumps(result))
    except Exception as error:
        code=str(error)
        if not re.fullmatch(r'[A-Z][A-Z0-9_]{1,100}',code):code='NATIVE_RESOURCE_UNCERTAIN'
        print(json.dumps({'error':code}))
        sys.exit(1)

if __name__ == '__main__':
    main()
