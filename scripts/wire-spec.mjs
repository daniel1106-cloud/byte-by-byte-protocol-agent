// Declarative wire codec: no eval, generated code, repository lookup or network.
const error = message => Object.assign(new Error(message), {code:'WIRE_SPEC'});
const need = (value,message) => {if(!value) throw error(message);};
const isObject = value => value && typeof value==='object' && !Array.isArray(value);
const isHex = value => typeof value==='string' && /^(?:[a-fA-F0-9]{2})+$/.test(value);
const integer = (value,width) => Number.isSafeInteger(value)&&value>=0&&value<2**(8*width);
const maxBytes = 4096;

export const WIRE_SPEC_GUIDANCE = [
  'Produce an application-layer specification, not merely TCP ports or capture metadata.',
  'Compare request and reply payloads across ALL sessions. Infer field widths, byte order, payload lengths, command codes and semantic relationships; label unsupported claims unknown.',
  'Executable subset: spec={"format":"wire-spec-v1","transport":"tcp","request":{"fields":[...]},"response":{"fields":[...]},"semantics":"supported behavior and limits"}.',
  'Each fields entry has a unique name and type. Supported entries: {name,type:"const",hex:"even-length hex"}; {name,type:"uint",bytes:1|2|4,endian:"big"|"little"}; {name,type:"length",bytes:1|2|4,endian:"big"|"little",of:"name of one later field whose BYTES are counted"}; {name,type:"uint_array",bytes:1|2|4,endian:"big"|"little"}; {name,type:"bytes"}.',
  'Variable uint_array/bytes must be the final field and have a preceding length field referring to them. Lengths may also refer to later fixed scalar fields. Const fields are literal bytes including recovered discriminators. uint and uint_array fields take application input under their name.',
  'Choose ONE evidence-supported successful message type for the executable subset. For that message type, encode fixed version/command/status/discriminator bytes as const, including their observed values; reserve uint/uint_array for variable application arguments or results. Describe other message types and uncertain discriminator values in semantics/unknowns.',
  'Before returning, mentally serialize and parse your candidate against the supplied complete application streams: every byte must be accounted for in order, scalar widths and byte lengths must agree, and the selected request and response must represent the same exchange. Do not silently omit header bytes or treat fixed control bytes as caller-supplied arguments.',
  'Only this one-request/one-response subset is executable by the reference client. Put other commands, errors, state rules and ambiguity in semantics/unknowns; do not invent them or force an unsupported protocol into the subset.',
  'Every observation quote must be one exact unchanged contiguous substring from evidence.text. Prefer a SINGLE short existing line; never join separated dump lines or paraphrase numbers. No ellipses inside quotes.',
].join(' ');

export function validateWireSpec(spec) {
  need(isObject(spec)&&spec.format==='wire-spec-v1'&&spec.transport==='tcp','Unsupported or incomplete wire-spec-v1');
  for(const direction of ['request','response']) {
    const fields=spec[direction]?.fields;
    need(Array.isArray(fields)&&fields.length>0&&fields.length<=32,`${direction} needs 1..32 fields`);
    const names=new Set();
    fields.forEach((field,index)=>{
      need(isObject(field)&&typeof field.name==='string'&&/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(field.name), 'Invalid field name');
      need(!names.has(field.name),'Duplicate field name');names.add(field.name);
      need(['const','uint','length','uint_array','bytes'].includes(field.type),'Unsupported or unknown field type');
      const allowed=['name','type',...(field.type==='const'?['hex']:field.type==='bytes'?[]:['bytes','endian']),...(field.type==='length'?['of']:[])];
      need(Object.keys(field).every(key=>allowed.includes(key)),'Unsupported field attribute');
      if(field.type==='const') need(isHex(field.hex)&&field.hex.length<=2*maxBytes,'Invalid constant hex');
      if(['uint','length','uint_array'].includes(field.type))
        need([1,2,4].includes(field.bytes)&&['big','little'].includes(field.endian),'Numeric fields need width and byte order');
      if(field.type==='length') {
        need(typeof field.of==='string'&&fields.slice(index+1).some(f=>f.name===field.of),'Length must count a later field');
      }
      if(['bytes','uint_array'].includes(field.type)) {
        need(index===fields.length-1,'Variable field must be last');
        need(fields.slice(0,index).some(f=>f.type==='length'&&f.of===field.name),'Variable field needs a preceding byte length');
      }
    });
    for(const field of fields.filter(f=>f.type!=='const'&&f.type!=='length'))
      need(!['__proto__','prototype','constructor'].includes(field.name),'Reserved input field name');
  }
  return spec;
}

function uintBuffer(value,field) {
  need(integer(value,field.bytes),`Out-of-range integer for ${field.name}`);
  const out=Buffer.alloc(field.bytes);
  out[field.endian==='big'?'writeUIntBE':'writeUIntLE'](value,0,field.bytes);
  return out;
}
export function encodeMessage(spec,direction,values={}) {
  validateWireSpec(spec);need(['request','response'].includes(direction),'Invalid message direction');
  need(isObject(values),'Input must be an object');
  const fields=spec[direction].fields, encoded=new Map();
  const inputs=fields.filter(f=>!['length','const'].includes(f.type)).map(f=>f.name);
  need(Object.keys(values).every(name=>inputs.includes(name)),'Unexpected input field');
  for(const field of fields) {
    if(field.type==='const') encoded.set(field.name,Buffer.from(field.hex,'hex'));
    else if(field.type==='uint') encoded.set(field.name,uintBuffer(values[field.name],field));
    else if(field.type==='uint_array') {
      const array=values[field.name];need(Array.isArray(array)&&array.length<=maxBytes/field.bytes,'Invalid integer array');
      encoded.set(field.name,Buffer.concat(array.map(value=>uintBuffer(value,field))));
    } else if(field.type==='bytes') {
      const hex=values[field.name];need(hex===''||isHex(hex),'Bytes input must be hex');
      need(hex.length<=2*maxBytes,'Bytes input too large');encoded.set(field.name,Buffer.from(hex,'hex'));
    }
  }
  for(const field of [...fields].reverse()) if(field.type==='length')
    encoded.set(field.name,uintBuffer(encoded.get(field.of).length,field));
  const frame=Buffer.concat(fields.map(field=>encoded.get(field.name)));
  need(frame.length<=maxBytes,'Frame too large');return frame;
}

export function decodeMessage(spec,direction,bytes) {
  validateWireSpec(spec);need(['request','response'].includes(direction),'Invalid message direction');
  need(Buffer.isBuffer(bytes)&&bytes.length<=maxBytes,'Expected bounded bytes');
  const values=Object.create(null),lengths=new Map(),spans=new Map();let offset=0;
  for(const field of spec[direction].fields) {
    const start=offset;
    const size=field.type==='const'?field.hex.length/2:['bytes','uint_array'].includes(field.type)?lengths.get(field.name):field.bytes;
    need(Number.isSafeInteger(size)&&size>=0&&size<=maxBytes,'Invalid declared frame length');
    if(bytes.length-offset<size)return {complete:false,needed:offset+size};
    const piece=bytes.subarray(offset,offset+size);offset+=size;
    if(field.type==='const')need(piece.equals(Buffer.from(field.hex,'hex')),`Constant mismatch at ${field.name}`);
    else if(['uint','length'].includes(field.type)) {
      const value=piece[field.endian==='big'?'readUIntBE':'readUIntLE'](0,field.bytes);
      if(field.type==='length') {
        if(lengths.has(field.of))need(lengths.get(field.of)===value,'Conflicting lengths');
        lengths.set(field.of,value);
      } else values[field.name]=value;
    } else if(field.type==='bytes') values[field.name]=piece.toString('hex');
    else {
      need(size%field.bytes===0,'Array byte length is not aligned');values[field.name]=[];
      for(let i=0;i<size;i+=field.bytes)values[field.name].push(piece[field.endian==='big'?'readUIntBE':'readUIntLE'](i,field.bytes));
    }
    spans.set(field.name,offset-start);
  }
  for(const [name,length] of lengths)need(spans.get(name)===length,`Incorrect byte length for ${name}`);
  return {complete:true,values,bytes_consumed:offset,remaining_hex:bytes.subarray(offset).toString('hex')};
}
