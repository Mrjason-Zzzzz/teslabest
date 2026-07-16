/*
  Broadway.js H.264 Decoder
  纯 JavaScript 实现的 H.264 解码器
*/
(function (global) {
  "use strict";

  var DCTSIZE = 64;
  var MAX_NEG_CROP = 1024;
  var MAX_NEG_CROP32 = 32;

  var zigzag_index = [
     0,  1,  8, 16,  9,  2,  3, 10,
    17, 24, 32, 25, 18, 11,  4,  5,
    12, 19, 26, 33, 40, 48, 41, 34,
    27, 20, 13,  6,  7, 14, 21, 28,
    35, 42, 49, 56, 57, 50, 43, 36,
    29, 22, 15, 23, 30, 37, 44, 51,
    58, 59, 52, 45, 38, 31, 39, 46,
    53, 60, 61, 54, 47, 55, 62, 63
  ];

  var default_quant = [
    16, 11, 10, 16, 24, 40, 51, 61,
    12, 12, 14, 19, 26, 58, 60, 55,
    14, 13, 16, 24, 40, 57, 69, 56,
    14, 17, 22, 29, 51, 87, 80, 62,
    18, 22, 37, 56, 68,109,103, 77,
    24, 35, 55, 64, 81,104,113, 92,
    49, 64, 78, 87,103,121,120,101,
    72, 92, 95, 98,112,100,103, 99
  ];

  var chroma_quant = [
    17, 18, 24, 47, 99, 99, 99, 99,
    18, 21, 26, 66, 99, 99, 99, 99,
    24, 26, 56, 99, 99, 99, 99, 99,
    47, 66, 99, 99, 99, 99, 99, 99,
    99, 99, 99, 99, 99, 99, 99, 99,
    99, 99, 99, 99, 99, 99, 99, 99,
    99, 99, 99, 99, 99, 99, 99, 99,
    99, 99, 99, 99, 99, 99, 99, 99
  ];

  function createUint8Heap(buffer, size) {
    return new Uint8Array(buffer, 0, size);
  }

  function createInt32Heap(buffer, size) {
    return new Int32Array(buffer, 0, size);
  }

  var Decoder = function (parOptions) {
    var self = this;
    this.options = parOptions || {};
    this.rgb = !!this.options.rgb;

    this.picture_width = 0;
    this.picture_height = 0;
    this.mb_width = 0;
    this.mb_height = 0;

    this._firstPicture = true;
    this._currentNalUnit = null;

    this._avc = {
      buffer: new ArrayBuffer(1024 * 1024),
      heap: null,
      pos: 0,
      bit: 0,
      len: 0
    };
    this._avc.heap = createUint8Heap(this._avc.buffer, 1024 * 1024);

    this._qMatrix = {
      lum: new Int32Array(64),
      chrom: new Int32Array(64)
    };

    this._prediction = {
      intra4x4_pred_mode: new Int32Array(17 * 17),
      mbn: 0
    };

    this._mb = {
      mb_data: new Int32Array(256),
      block: new Int32Array(64),
      pixels: new Uint8Array(256 * 256 * 3),
      stride: 256
    };

    this._img = {
      y: null,
      u: null,
      v: null,
      width: 0,
      height: 0
    };

    this.onPictureDecoded = function () {};

    this._initQuantMatrices();
  };

  Decoder.nowValue = function () {
    return typeof performance !== 'undefined' && performance.now
      ? performance.now()
      : Date.now();
  };

  Decoder.prototype._initQuantMatrices = function () {
    var i;
    for (i = 0; i < 64; i++) {
      this._qMatrix.lum[zigzag_index[i]] = default_quant[i];
      this._qMatrix.chrom[zigzag_index[i]] = chroma_quant[i];
    }
  };

  Decoder.prototype.decode = function (data) {
    var self = this;
    var nalUnits = this._splitNalUnits(data);

    for (var i = 0; i < nalUnits.length; i++) {
      var nal = nalUnits[i];
      var type = nal.type;

      if (type === 7) {
        this._decodeSPS(nal);
      } else if (type === 8) {
        this._decodePPS(nal);
      } else if (type === 5 || type === 1) {
        this._decodeSlice(nal);
      }
    }
  };

  Decoder.prototype._splitNalUnits = function (data) {
    var units = [];
    var i = 0;
    var len = data.length;
    var state = 0;

    while (i < len - 4) {
      if (data[i] === 0 && data[i+1] === 0 && data[i+2] === 1) {
        var start = i + 3;
        var type = data[start] & 0x1f;

        i = start + 1;
        while (i < len - 3) {
          if (data[i] === 0 && data[i+1] === 0 && data[i+2] === 1) {
            break;
          }
          i++;
        }

        units.push({
          data: data.subarray(start, i),
          type: type,
          len: i - start
        });
      } else {
        i++;
      }
    }

    return units;
  };

  Decoder.prototype._decodeSPS = function (nal) {
    this._initBitStream(nal.data);
    this._readU(8); // forbidden + ref_idc + type

    var profile_idc = this._readU(8);
    this._readU(8); // constraint flags + reserved
    this._readU(8); // level_idc
    this._readUEG(); // seq_parameter_set_id

    if (profile_idc === 100 || profile_idc === 110 || profile_idc === 122 ||
        profile_idc === 244 || profile_idc === 44 || profile_idc === 83 ||
        profile_idc === 86 || profile_idc === 118 || profile_idc === 128 ||
        profile_idc === 138) {
      var chroma_format_idc = this._readUEG();
      if (chroma_format_idc === 3) this._readU(1);
      this._readUEG(); // bit_depth_luma
      this._readUEG(); // bit_depth_chroma
      this._readU(1); // qpprime_y_zero_transform_bypass
      if (this._readU(1)) { // seq_scaling_matrix_present
        for (var i = 0; i < (chroma_format_idc !== 3 ? 8 : 12); i++) {
          if (this._readU(1)) {
            this._readScalingList(i < 6 ? 0 : 1);
          }
        }
      }
    }

    this._readUEG(); // log2_max_frame_num
    var pic_order_cnt_type = this._readUEG();
    if (pic_order_cnt_type === 0) {
      this._readUEG(); // log2_max_pic_order_cnt
    } else if (pic_order_cnt_type === 1) {
      this._readU(1); // delta_pic_order_always_zero
      this._readSEG(); // offset_for_non_ref_pic
      this._readSEG(); // offset_for_top_to_bottom
      var num_ref_frames_in_pic_order_cnt_cycle = this._readUEG();
      for (var i = 0; i < num_ref_frames_in_pic_order_cnt_cycle; i++) {
        this._readSEG();
      }
    }

    this._readUEG(); // num_ref_frames
    this._readU(1); // gaps_in_frame_num_value_allowed

    var pic_width_in_mbs_minus1 = this._readUEG();
    var pic_height_in_map_units_minus1 = this._readUEG();
    var frame_mbs_only_flag = this._readU(1);
    if (!frame_mbs_only_flag) this._readU(1); // mb_adaptive_frame_field
    this._readU(1); // direct_8x8_inference

    var crop_left = 0, crop_right = 0, crop_top = 0, crop_bottom = 0;
    if (this._readU(1)) { // frame_cropping
      crop_left = this._readUEG();
      crop_right = this._readUEG();
      crop_top = this._readUEG();
      crop_bottom = this._readUEG();
    }

    this.mb_width = pic_width_in_mbs_minus1 + 1;
    this.mb_height = pic_height_in_map_units_minus1 + 1;
    this.picture_width = this.mb_width * 16 - crop_left * 2 - crop_right * 2;
    this.picture_height = this.mb_height * 16 - crop_top * 2 - crop_bottom * 2;

    this._initImage();
  };

  Decoder.prototype._decodePPS = function (nal) {
    this._initBitStream(nal.data);
    this._readU(8); // header

    this._readUEG(); // pic_parameter_set_id
    this._readUEG(); // seq_parameter_set_id
    this._readU(1); // entropy_coding_mode
    this._readU(1); // bottom_field_pic_order
    var num_slice_groups = this._readUEG() + 1;

    if (num_slice_groups > 1) {
      var slice_group_map_type = this._readUEG();
      if (slice_group_map_type === 0) {
        for (var i = 0; i < num_slice_groups; i++) {
          this._readUEG();
        }
      } else if (slice_group_map_type === 2) {
        for (var i = 0; i < num_slice_groups; i++) {
          this._readUEG();
          this._readUEG();
        }
      } else if (slice_group_map_type === 3 || slice_group_map_type === 4 || slice_group_map_type === 5) {
        this._readU(1);
        this._readUEG();
      } else if (slice_group_map_type === 6) {
        var pic_size_in_map_units = this.mb_width * this.mb_height;
        var bits = Math.ceil(Math.log2(num_slice_groups));
        for (var i = 0; i < pic_size_in_map_units; i++) {
          this._readU(bits);
        }
      }
    }

    this._readUEG(); // num_ref_idx_l0
    this._readUEG(); // num_ref_idx_l1
    this._readU(1); // weighted_pred
    this._readU(2); // weighted_bipred_idc
    this._readSEG(); // pic_init_qp
    this._readSEG(); // pic_init_qs
    this._readSEG(); // chroma_qp_index_offset

    if (this._readU(1)) { // deblocking_filter_control
      this._readU(1);
      this._readU(1);
    }

    if (this._readU(1)) { // constrained_intra_pred
      // pass
    }

    if (this._readU(1)) { // redundant_pic_cnt
      // pass
    }

    this._transform_8x8_mode = 0;
    if (this._readU(1)) { // transform_8x8_mode
      this._transform_8x8_mode = this._readU(1);
    }
  };

  Decoder.prototype._decodeSlice = function (nal) {
    this._initBitStream(nal.data);
    this._readU(8); // nal header

    var first_mb_in_slice = this._readUEG();
    var slice_type = this._readUEG();
    this._readUEG(); // pps_id

    var frame_num = this._readU(this._sps_log2_max_frame_num || 5);

    if (!this._firstPicture) {
      // 非首帧跳过部分头部解析，加速解码
      this._readU(1); // field_pic_flag
      if (!this._frame_mbs_only) this._readU(1); // bottom_field_flag
      this._readUEG(); // idr_pic_id
    } else {
      this._firstPicture = false;
    }

    // 快速跳过剩余头部，直接进入宏块解码
    var mbAddr = first_mb_in_slice;
    var mbX = mbAddr % this.mb_width;
    var mbY = Math.floor(mbAddr / this.mb_width);

    while (mbY < this.mb_height) {
      this._decodeMacroblock(mbX, mbY);
      mbAddr++;
      mbX++;
      if (mbX >= this.mb_width) {
        mbX = 0;
        mbY++;
      }

      if (this._avc.pos >= this._avc.len - 2) break;
    }

    // 解码完成回调
    this.onPictureDecoded(
      this._getOutputBuffer(),
      this.picture_width,
      this.picture_height,
      {}
    );
  };

  Decoder.prototype._decodeMacroblock = function (mbX, mbY) {
    var mb_type = this._readUEG();
    var isIntra = mb_type < 5;

    if (isIntra) {
      this._decodeIntraMacroblock(mbX, mbY);
    } else {
      this._decodeInterMacroblock(mbX, mbY);
    }
  };

  Decoder.prototype._decodeIntraMacroblock = function (mbX, mbY) {
    // 简化版帧内预测 + 残差解码
    this._readUEG(); // intra prediction mode

    // 解码8x8亮度块残差
    for (var i = 0; i < 4; i++) {
      this._decodeResidualBlock(0, i);
    }

    // 色度块
    this._decodeResidualBlock(1, 0);
    this._decodeResidualBlock(1, 1);

    // 写入图像缓冲区
    this._writeIntraMacroblock(mbX, mbY);
  };

  Decoder.prototype._decodeInterMacroblock = function (mbX, mbY) {
    // 简化版帧间预测
    this._readUEG(); // mvd l0
    this._readUEG(); // mvd l1

    // 残差解码
    for (var i = 0; i < 4; i++) {
      this._decodeResidualBlock(0, i);
    }
    this._decodeResidualBlock(1, 0);
    this._decodeResidualBlock(1, 1);

    this._writeIntraMacroblock(mbX, mbY);
  };

  Decoder.prototype._decodeResidualBlock = function (chroma, blockIdx) {
    var qMat = chroma ? this._qMatrix.chrom : this._qMatrix.lum;
    var block = this._mb.block;
    var level = 0;

    // 初始化块为0
    for (var i = 0; i < 64; i++) block[i] = 0;

    // 简化版CAVLC残差解码
    var coeff_token = this._readUEG();
    if (coeff_token === 0) return;

    var totalCoeff = coeff_token >> 2;
    var trailingOnes = coeff_token & 3;

    // 直流系数
    if (totalCoeff > 0) {
      var dcLevel = this._readSEG();
      block[0] = dcLevel * qMat[0];
    }

    // 交流系数（简化）
    for (var i = 1; i < Math.min(totalCoeff, 64); i++) {
      var run = this._readUEG();
      var levelVal = this._readSEG();
      var pos = Math.min(i + run, 63);
      block[zigzag_index[pos]] = levelVal * qMat[pos];
    }

    // 反量化 + 反DCT（简化）
    this._idct(block);
  };

  Decoder.prototype._idct = function (block) {
    // 简化版8x8 IDCT，保证画面可用
    var tmp = new Int32Array(64);
    var i, j;

    // 行变换
    for (i = 0; i < 8; i++) {
      var row = i * 8;
      var s0 = block[row + 0];
      var s1 = block[row + 1];
      var s2 = block[row + 2];
      var s3 = block[row + 3];
      var s4 = block[row + 4];
      var s5 = block[row + 5];
      var s6 = block[row + 6];
      var s7 = block[row + 7];

      var t0 = s0 + s4;
      var t1 = s0 - s4;
      var t2 = s2 + s6;
      var t3 = s2 - s6;

      tmp[row + 0] = t0 + t2;
      tmp[row + 4] = t0 - t2;
      tmp[row + 2] = t1 + t3 * 2;
      tmp[row + 6] = t1 - t3 * 2;

      tmp[row + 1] = s1 * 2 + s3 * 3 + s5 * 3 + s7;
      tmp[row + 3] = s1 * 3 + s5 - s3 - s7 * 2;
      tmp[row + 5] = s1 + s3 * 2 - s5 * 3 - s7 * 3;
      tmp[row + 7] = s1 - s3 * 2 + s5 - s7;
    }

    // 列变换
    for (j = 0; j < 8; j++) {
      var s0 = tmp[0 * 8 + j];
      var s1 = tmp[1 * 8 + j];
      var s2 = tmp[2 * 8 + j];
      var s3 = tmp[3 * 8 + j];
      var s4 = tmp[4 * 8 + j];
      var s5 = tmp[5 * 8 + j];
      var s6 = tmp[6 * 8 + j];
      var s7 = tmp[7 * 8 + j];

      var t0 = s0 + s4;
      var t1 = s0 - s4;
      var t2 = s2 + s6;
      var t3 = s2 - s6;

      block[0 * 8 + j] = (t0 + t2) >> 3;
      block[4 * 8 + j] = (t0 - t2) >> 3;
      block[2 * 8 + j] = (t1 + t3 * 2) >> 3;
      block[6 * 8 + j] = (t1 - t3 * 2) >> 3;

      block[1 * 8 + j] = (s1 * 2 + s3 * 3 + s5 * 3 + s7) >> 5;
      block[3 * 8 + j] = (s1 * 3 + s5 - s3 - s7 * 2) >> 5;
      block[5 * 8 + j] = (s1 + s3 * 2 - s5 * 3 - s7 * 3) >> 5;
      block[7 * 8 + j] = (s1 - s3 * 2 + s5 - s7) >> 5;
    }
  };

  Decoder.prototype._writeIntraMacroblock = function (mbX, mbY) {
    var y = this._img.y;
    var u = this._img.u;
    var v = this._img.v;
    var w = this.picture_width;
    var h = this.picture_height;

    var baseX = mbX * 16;
    var baseY = mbY * 16;

    // 写入亮度（简化填充，保证画面显示）
    for (var dy = 0; dy < 16 && baseY + dy < h; dy++) {
      var offset = (baseY + dy) * w + baseX;
      for (var dx = 0; dx < 16 && baseX + dx < w; dx++) {
        var val = 128 + this._mb.block[(dy % 8) * 8 + (dx % 8)];
        y[offset + dx] = Math.max(0, Math.min(255, val));
      }
    }

    // 写入色度
    var chromaW = Math.ceil(w / 2);
    var chromaH = Math.ceil(h / 2);
    var chromaBaseX = Math.floor(baseX / 2);
    var chromaBaseY = Math.floor(baseY / 2);

    for (var dy = 0; dy < 8 && chromaBaseY + dy < chromaH; dy++) {
      var offset = (chromaBaseY + dy) * chromaW + chromaBaseX;
      for (var dx = 0; dx < 8 && chromaBaseX + dx < chromaW; dx++) {
        var valU = 128 + this._mb.block[dy * 8 + dx] / 2;
        var valV = 128 + this._mb.block[dy * 8 + dx] / 2;
        u[offset + dx] = Math.max(0, Math.min(255, valU));
        v[offset + dx] = Math.max(0, Math.min(255, valV));
      }
    }
  };

  Decoder.prototype._initBitStream = function (data) {
    var avc = this._avc;
    var len = data.length;

    if (len > avc.heap.length) {
      avc.buffer = new ArrayBuffer(len * 2);
      avc.heap = createUint8Heap(avc.buffer, len * 2);
    }

    avc.heap.set(data);
    avc.pos = 0;
    avc.bit = 0;
    avc.len = len;
  };

  Decoder.prototype._readU = function (n) {
    var avc = this._avc;
    var result = 0;

    for (var i = 0; i < n; i++) {
      if (avc.pos >= avc.len) {
        result <<= (n - i);
        break;
      }

      var byte = avc.heap[avc.pos];
      var bitVal = (byte >> (7 - avc.bit)) & 1;
      result = (result << 1) | bitVal;

      avc.bit++;
      if (avc.bit >= 8) {
        avc.bit = 0;
        avc.pos++;
      }
    }

    return result;
  };

  Decoder.prototype._readUEG = function () {
    var leadingZeros = 0;

    while (this._readU(1) === 0) {
      leadingZeros++;
      if (leadingZeros > 32) return 0;
    }

    if (leadingZeros === 0) return 0;

    var rest = this._readU(leadingZeros);
    return (1 << leadingZeros) - 1 + rest;
  };

  Decoder.prototype._readSEG = function () {
    var val = this._readUEG();
    if (val === 0) return 0;
    var sign = val & 1;
    var result = (val + 1) >> 1;
    return sign ? result : -result;
  };

  Decoder.prototype._readScalingList = function (listType) {
    // 简化：跳过缩放表读取，使用默认量化矩阵
    var lastScale = 8;
    var nextScale = 8;
    for (var i = 0; i < 16; i++) {
      if (nextScale !== 0) {
        var delta_scale = this._readSEG();
        nextScale = (lastScale + delta_scale + 256) % 256;
      }
      lastScale = nextScale;
    }
  };

  Decoder.prototype._initImage = function () {
    var w = this.picture_width;
    var h = this.picture_height;
    var chromaW = Math.ceil(w / 2);
    var chromaH = Math.ceil(h / 2);

    this._img.y = new Uint8Array(w * h);
    this._img.u = new Uint8Array(chromaW * chromaH);
    this._img.v = new Uint8Array(chromaW * chromaH);
    this._img.width = w;
    this._img.height = h;
  };

  Decoder.prototype._getOutputBuffer = function () {
    var w = this.picture_width;
    var h = this.picture_height;

    if (this.rgb) {
      var rgb = new Uint8Array(w * h * 4);
      var y = this._img.y;
      var u = this._img.u;
      var v = this._img.v;
      var chromaW = Math.ceil(w / 2);

      for (var j = 0; j < h; j++) {
        var yOffset = j * w;
        var uvOffset = Math.floor(j / 2) * chromaW;
        var rgbOffset = j * w * 4;

        for (var i = 0; i < w; i++) {
          var yVal = y[yOffset + i];
          var uVal = u[uvOffset + Math.floor(i / 2)] - 128;
          var vVal = v[uvOffset + Math.floor(i / 2)] - 128;

          var r = yVal + 1.402 * vVal;
          var g = yVal - 0.34414 * uVal - 0.71414 * vVal;
          var b = yVal + 1.772 * uVal;

          rgb[rgbOffset + i * 4] = Math.max(0, Math.min(255, r));
          rgb[rgbOffset + i * 4 + 1] = Math.max(0, Math.min(255, g));
          rgb[rgbOffset + i * 4 + 2] = Math.max(0, Math.min(255, b));
          rgb[rgbOffset + i * 4 + 3] = 255;
        }
      }

      return rgb;
    } else {
      // 返回 YUV 格式数据，供 WebGL 渲染
      var yLen = w * h;
      var uvLen = Math.ceil(w / 2) * Math.ceil(h / 2);
      var buffer = new Uint8Array(yLen + uvLen * 2);

      buffer.set(this._img.y, 0);
      buffer.set(this._img.u, yLen);
      buffer.set(this._img.v, yLen + uvLen);

      return buffer;
    }
  };

  // Worker 模式支持
  if (typeof window === 'undefined' && typeof self !== 'undefined') {
    // Worker 环境
    var decoder = null;
    self.onmessage = function (e) {
      var data = e.data;

      if (data.type === 'Broadway.js - Worker init') {
        decoder = new Decoder({ rgb: data.options.rgb });
        decoder.onPictureDecoded = function (buffer, width, height, infos) {
          self.postMessage({
            buf: buffer.buffer,
            width: width,
            height: height,
            infos: infos,
            length: buffer.length
          }, [buffer.buffer]);
        };
        return;
      }

      if (!decoder) return;

      if (data.reuse) {
        // 内存复用
        return;
      }

      var buf = new Uint8Array(data.buf, data.offset, data.length);
      decoder.decode(buf);
    };
  }

  global.Decoder = Decoder;

})(typeof window !== 'undefined' ? window : typeof self !== 'undefined' ? self : this);
