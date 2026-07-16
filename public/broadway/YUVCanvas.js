/*
  Broadway.js YUV Canvas WebGL Renderer
  WebGL 绘制 YUV 格式视频帧
*/
(function (global) {
  "use strict";

  var WebGLCanvas = function (options) {
    options = options || {};
    this.canvas = options.canvas || document.createElement('canvas');
    this.contextOptions = options.contextOptions || {};
    this.width = options.width || 0;
    this.height = options.height || 0;

    this._gl = null;
    this._program = null;
    this._textures = {};
    this._buffers = {};

    this._initGL();
  };

  WebGLCanvas.prototype._initGL = function () {
    var gl = this.canvas.getContext('webgl', this.contextOptions)
            || this.canvas.getContext('experimental-webgl', this.contextOptions);

    if (!gl) {
      throw new Error('WebGL not supported');
    }

    this._gl = gl;

    // 顶点着色器
    var vertexShaderSource = `
      attribute vec2 a_position;
      attribute vec2 a_texCoord;
      varying vec2 v_texCoord;
      void main() {
        gl_Position = vec4(a_position, 0.0, 1.0);
        v_texCoord = a_texCoord;
      }
    `;

    // 片段着色器：YUV 转 RGB
    var fragmentShaderSource = `
      precision mediump float;
      varying vec2 v_texCoord;
      uniform sampler2D u_yTexture;
      uniform sampler2D u_uTexture;
      uniform sampler2D u_vTexture;
      void main() {
        float y = texture2D(u_yTexture, v_texCoord).r;
        float u = texture2D(u_uTexture, v_texCoord).r - 0.5;
        float v = texture2D(u_vTexture, v_texCoord).r - 0.5;

        float r = y + 1.402 * v;
        float g = y - 0.34414 * u - 0.71414 * v;
        float b = y + 1.772 * u;

        gl_FragColor = vec4(r, g, b, 1.0);
      }
    `;

    var vertexShader = this._createShader(gl.VERTEX_SHADER, vertexShaderSource);
    var fragmentShader = this._createShader(gl.FRAGMENT_SHADER, fragmentShaderSource);

    var program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error('Shader program link failed');
    }

    this._program = program;
    gl.useProgram(program);

    // 创建顶点缓冲
    var positionBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1,  1, -1,  -1, 1,
       1, -1,  1,  1,  -1, 1
    ]), gl.STATIC_DRAW);

    var positionLocation = gl.getAttribLocation(program, 'a_position');
    gl.enableVertexAttribArray(positionLocation);
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

    // 纹理坐标缓冲
    var texCoordBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      0, 1,  1, 1,  0, 0,
      1, 1,  1, 0,  0, 0
    ]), gl.STATIC_DRAW);

    var texCoordLocation = gl.getAttribLocation(program, 'a_texCoord');
    gl.enableVertexAttribArray(texCoordLocation);
    gl.vertexAttribPointer(texCoordLocation, 2, gl.FLOAT, false, 0, 0);

    // 创建三个纹理
    this._textures.y = this._createTexture(0);
    this._textures.u = this._createTexture(1);
    this._textures.v = this._createTexture(2);

    gl.uniform1i(gl.getUniformLocation(program, 'u_yTexture'), 0);
    gl.uniform1i(gl.getUniformLocation(program, 'u_uTexture'), 1);
    gl.uniform1i(gl.getUniformLocation(program, 'u_vTexture'), 2);

    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  };

  WebGLCanvas.prototype._createShader = function (type, source) {
    var gl = this._gl;
    var shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);

    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error('Shader compile failed: ' + gl.getShaderInfoLog(shader));
    }

    return shader;
  };

  WebGLCanvas.prototype._createTexture = function (unit) {
    var gl = this._gl;
    var texture = gl.createTexture();

    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    return texture;
  };

  WebGLCanvas.prototype.drawNextOutputPicture = function (options) {
    var gl = this._gl;
    var yData = options.yData;
    var uData = options.uData;
    var vData = options.vData;
    var width = options.width;
    var height = options.height;

    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
      gl.viewport(0, 0, width, height);
    }

    // 更新 Y 纹理
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._textures.y);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, width, height, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, yData);

    // 更新 U 纹理
    var uvWidth = Math.ceil(width / 2);
    var uvHeight = Math.ceil(height / 2);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this._textures.u);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, uvWidth, uvHeight, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, uData);

    // 更新 V 纹理
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this._textures.v);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, uvWidth, uvHeight, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, vData);

    // 绘制
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  };

  global.YUVCanvas = WebGLCanvas;

})(typeof window !== 'undefined' ? window : typeof self !== 'undefined' ? self : this);
